/**
 * Coverage — where the deck is thick and where it is thin.
 *
 * A thousand words is too many to hold in your head, so the question "what
 * should this week's fifty be?" stops being answerable by scrolling. The matrix
 * answers it directly: topics down, CEFR levels across, one cell per pair.
 * Clicking a cell filters the library to exactly those words, so a gap found
 * here becomes the next batch in one move.
 *
 * Cells are shaded relative to the busiest cell rather than on an absolute
 * scale — the useful signal is which pairs lag the others in THIS deck.
 *
 * Exports: CoveragePanel
 * Depends on: ../lib/contract.ts, ../lib/library.ts, ../lib/types.ts
 */
import { useMemo } from "react";
import { EXAMS, TOPICS } from "../lib/contract";
import { EMPTY_FILTER, type LibraryFilter } from "../lib/library";
import { CEFR_LEVELS, type CefrLevel, type ReviewEntry } from "../lib/types";

export function CoveragePanel({
  entries,
  onDrillDown,
}: {
  entries: readonly ReviewEntry[];
  onDrillDown: (filter: LibraryFilter) => void;
}) {
  const { grid, topicTotals, levelTotals, busiest, examTotals, untagged } = useMemo(() => {
    const grid = new Map<string, number>();
    const topicTotals = new Map<string, number>();
    const levelTotals = new Map<string, number>();
    const examTotals = new Map<string, number>();
    let busiest = 0;
    let untagged = 0;

    for (const entry of entries) {
      const { level, topics, exams } = entry.deckWord;
      levelTotals.set(level, (levelTotals.get(level) ?? 0) + 1);
      // A word counts in every topic it carries, so the rows overlap on purpose:
      // the matrix answers "how well is this pair covered", not "how do the
      // words partition".
      for (const topic of topics) {
        const key = `${topic}/${level}`;
        const next = (grid.get(key) ?? 0) + 1;
        grid.set(key, next);
        if (next > busiest) busiest = next;
        topicTotals.set(topic, (topicTotals.get(topic) ?? 0) + 1);
      }
      for (const exam of exams) examTotals.set(exam, (examTotals.get(exam) ?? 0) + 1);
      if (exams.length === 0) untagged += 1;
    }
    return { grid, topicTotals, levelTotals, busiest, examTotals, untagged };
  }, [entries]);

  const rows = TOPICS.filter((topic) => (topicTotals.get(topic) ?? 0) > 0);

  if (entries.length === 0) {
    return (
      <section className="panel">
        <h2>Coverage</h2>
        <div className="empty">
          Nothing to chart yet. Generate or import words and the gaps show up here.
        </div>
      </section>
    );
  }

  return (
    <section className="panel">
      <h2>Coverage</h2>
      <p className="hint">
        Every topic against every level, counting a word once per topic it carries. Click a cell to
        pull those words up in the library — a thin cell is the next batch.
      </p>

      <div style={{ overflowX: "auto" }}>
        <table className="coverage">
          <thead>
            <tr>
              <th scope="col">Topic</th>
              {CEFR_LEVELS.map((level) => (
                <th key={level} scope="col">
                  {level}
                  <span className="coverage-total">{levelTotals.get(level) ?? 0}</span>
                </th>
              ))}
              <th scope="col">All</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((topic) => (
              <tr key={topic}>
                <th scope="row">{topic}</th>
                {CEFR_LEVELS.map((level) => {
                  const count = grid.get(`${topic}/${level}`) ?? 0;
                  // Shade against the busiest cell: the signal is relative.
                  const weight = busiest === 0 ? 0 : count / busiest;
                  return (
                    <td key={level}>
                      <button
                        type="button"
                        className="coverage-cell"
                        data-empty={count === 0 || undefined}
                        style={{ "--weight": weight.toFixed(3) } as React.CSSProperties}
                        title={`${count} word(s) in ${topic} at ${level}`}
                        onClick={() =>
                          onDrillDown({
                            ...EMPTY_FILTER,
                            topics: [topic],
                            levels: [level as CefrLevel],
                          })
                        }
                      >
                        {count === 0 ? "·" : count}
                      </button>
                    </td>
                  );
                })}
                <td>
                  <button
                    type="button"
                    className="coverage-cell"
                    data-row-total="true"
                    onClick={() => onDrillDown({ ...EMPTY_FILTER, topics: [topic] })}
                  >
                    {topicTotals.get(topic) ?? 0}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 className="coverage-sub">Exam targets</h3>
      <div className="chips">
        {EXAMS.map((exam) => (
          <button
            key={exam}
            type="button"
            className="chip"
            onClick={() => onDrillDown({ ...EMPTY_FILTER, exams: [exam] })}
          >
            {exam.toUpperCase()} <span style={{ opacity: 0.7 }}>{examTotals.get(exam) ?? 0}</span>
          </button>
        ))}
      </div>
      <p className="note" style={{ color: "var(--muted)", fontSize: 12, marginTop: 8 }}>
        {untagged} of {entries.length} word(s) carry no exam tag. Select rows in the library to tag
        them in bulk.
      </p>
    </section>
  );
}
