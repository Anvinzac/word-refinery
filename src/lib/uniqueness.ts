/**
 * Keeping `anticipateVi` unique across a deck that keeps growing.
 *
 * The invitation to guess has to be different for every word — the validator
 * enforces it deck-wide — but generation sees only the fifty words of the
 * current run. Each batch therefore writes blind to the nine hundred lines
 * already shipped, and the model's instinct is to reach for the same stock
 * opener every time. Collisions are caught after the fact, and they compound:
 * the bigger the deck, the likelier each new batch collides with it.
 *
 * This module turns what the deck already uses into something the prompt can
 * carry. A thousand lines will not fit in a prompt, so it sends two things
 * instead, chosen because they attack the two ways these lines actually repeat:
 *
 *  - **Exact lines**, to satisfy the validator's exact-match rule. Short,
 *    frequently used lines come first: a long specific line ("Mùa gì mà nông
 *    dân chờ cả năm?") will never be written twice by accident, while a short
 *    generic one ("Đoán xem nào?") is precisely what recurs.
 *  - **Opening formulas**, tallied. These lines collide at the start far more
 *    than along their whole length, and a dozen openers cost a fraction of what
 *    a dozen full lines cost while covering far more of the risk.
 *
 * The validator stays the backstop: this makes collisions rare, not impossible.
 *
 * Exports: AvoidList, UniquenessContext, normalizeLine, openingOf,
 *          collectUniqueness, renderAvoidSection, createAvoidList
 * Depends on: ./emphasis.ts
 */
import { stripEmphasisMarkers } from "./emphasis.ts";

/** What the prompt is told to steer clear of. */
export interface UniquenessContext {
  /** Exact lines already in use, highest collision risk first. */
  lines: string[];
  /** Opening formulas and how often each is already used. */
  openings: Array<{ opening: string; count: number }>;
  /** How many distinct lines exist in total, so the prompt can say so. */
  totalLines: number;
}

/** How much of the prompt the avoid list may occupy. */
export interface UniquenessBudget {
  /** Characters of exact lines to include. */
  lineChars?: number;
  /** Opening formulas to include. */
  maxOpenings?: number;
}

const DEFAULT_BUDGET: Required<UniquenessBudget> = { lineChars: 1400, maxOpenings: 10 };

/**
 * Normalise a line the way the deck validator does, so "already used" here
 * means exactly what "duplicate" means there.
 *
 * @param value - a raw `anticipateVi` field, markers and all
 * @returns the comparison key: markers stripped, lowercased, spaces collapsed
 */
export function normalizeLine(value: string): string {
  return stripEmphasisMarkers(value).toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * The opening formula of a line — its first two words.
 *
 * Two is the useful unit: one word ("đoán") is too coarse to distinguish
 * openers, three starts capturing the specific content that makes a line
 * unique rather than the formula that makes it repeat.
 *
 * @param value - a raw or normalised line
 * @returns the lowercase opening, or "" for an empty line
 */
export function openingOf(value: string): string {
  const words = normalizeLine(value)
    .replace(/[?!.…,]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 0);
  return words.slice(0, 2).join(" ");
}

/**
 * Work out what a new batch should avoid.
 *
 * @param used - every `anticipateVi` already in the deck, in any order
 * @param budget - how much prompt space the result may take
 */
export function collectUniqueness(
  used: readonly string[],
  budget: UniquenessBudget = {},
): UniquenessContext {
  const { lineChars, maxOpenings } = { ...DEFAULT_BUDGET, ...budget };

  const counts = new Map<string, number>();
  for (const raw of used) {
    const line = normalizeLine(raw);
    if (line.length === 0) continue;
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }

  // Already-repeated lines first, then the shortest: both are stand-ins for
  // "most likely to be written again".
  const ranked = [...counts.entries()].sort((left, right) => {
    if (right[1] !== left[1]) return right[1] - left[1];
    if (left[0].length !== right[0].length) return left[0].length - right[0].length;
    return left[0].localeCompare(right[0]);
  });

  const lines: string[] = [];
  let spent = 0;
  for (const [line] of ranked) {
    const cost = line.length + 2;
    if (spent + cost > lineChars) break;
    lines.push(line);
    spent += cost;
  }

  const openingCounts = new Map<string, number>();
  for (const [line, count] of counts) {
    const opening = openingOf(line);
    if (opening.length === 0) continue;
    openingCounts.set(opening, (openingCounts.get(opening) ?? 0) + count);
  }
  const openings = [...openingCounts.entries()]
    .filter(([, count]) => count > 1)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, maxOpenings)
    .map(([opening, count]) => ({ opening, count }));

  return { lines, openings, totalLines: counts.size };
}

/**
 * Render the avoid list as prompt text.
 *
 * @param context - what the deck already uses
 * @returns the prompt section, or "" when there is nothing to avoid yet
 */
export function renderAvoidSection(context: UniquenessContext): string {
  if (context.totalLines === 0) return "";

  const parts: string[] = [
    `The deck already contains ${context.totalLines} "anticipateVi" line(s). Yours must not repeat any of them.`,
  ];

  if (context.openings.length > 0) {
    const worn = context.openings
      .map((entry) => `"${entry.opening}" (${entry.count}×)`)
      .join(", ");
    parts.push(
      `These openings are worn out — do NOT start a line with them: ${worn}. Open differently each time.`,
    );
  }

  if (context.lines.length > 0) {
    const shown = context.lines.map((line) => `- ${line}`).join("\n");
    const omitted = context.totalLines - context.lines.length;
    parts.push(
      `Already used verbatim${omitted > 0 ? ` (${context.lines.length} of ${context.totalLines} shown)` : ""}:\n${shown}`,
    );
  }

  return parts.join("\n\n");
}

/**
 * A running avoid list for one generation run.
 *
 * Lines produced by one batch are recorded, so the next batch of the same run
 * avoids them too — without this, a fifty-word run split into five calls can
 * collide with itself just as easily as with the deck.
 */
export interface AvoidList {
  /** The prompt section for the next batch, reflecting everything recorded so far. */
  section(): string;
  /** Record lines a batch produced. */
  add(lines: readonly string[]): void;
  /** Distinct lines known, for logging. */
  size(): number;
}

/**
 * Build a running avoid list seeded with the deck's existing lines.
 *
 * @param existing - every `anticipateVi` already in the deck
 * @param budget - how much prompt space the rendered section may take
 */
export function createAvoidList(
  existing: readonly string[],
  budget: UniquenessBudget = {},
): AvoidList {
  const used: string[] = [...existing];
  let cache: string | null = null;

  return {
    section(): string {
      // Rebuilt only after something is recorded: within a run the same section
      // is asked for once per batch, and re-ranking a thousand lines each time
      // would be wasted work.
      if (cache === null) cache = renderAvoidSection(collectUniqueness(used, budget));
      return cache;
    },
    add(lines: readonly string[]): void {
      let changed = false;
      for (const line of lines) {
        if (normalizeLine(line).length === 0) continue;
        used.push(line);
        changed = true;
      }
      if (changed) cache = null;
    },
    size(): number {
      return new Set(used.map(normalizeLine).filter((line) => line.length > 0)).size;
    },
  };
}
