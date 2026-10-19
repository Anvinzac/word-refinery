# Teaching the generator your voice

A design note, with the prompts written out so you can argue with them before any
of it is built.

---

## 1. The thing you already have and may not be using

You are about to **edit** 30 existing sentences. That means you will produce 30
**pairs** — the model's version and yours — not 30 good sentences.

The pair is worth far more than the final. A finished sentence shows the model
*a* way to write; a pair shows it **what you changed and what you left alone**,
which is the only signal that isolates your voice from the content. "Việc thu
gom cây trái" → "Mùa hái trái chín" says something no amount of finished
sentences says: that you prefer a concrete image to a nominalisation, and that
you will spend a syllable on "chín" to get it.

So: **keep the original.** When you edit, store the before. Everything below
assumes you have pairs. If you have already overwritten some, the finals still
work — they are just weaker teachers.

## 2. Two stages, not one

The obvious design is to paste all 30 examples into every request. Don't. It
costs 2–3k tokens on every batch, it dilutes as the set grows, and — the part
that matters for your question — **you cannot read it to find out what the model
thinks your style is.**

Instead:

**Stage A — distil, once.** Feed the 30 pairs to a model and have it write a
style guide: a page of concrete, checkable rules about your voice. You read it,
cross out what is wrong, add what it missed. *This is the artifact you review.*
It goes in the prompt store beside the other four, editable on the Prompts tab.

**Stage B — inject, every request.** The generation and rewrite prompts carry
the style guide (short, stable, human-edited) plus **6–8 exemplars chosen to
match what is being written** — same field, nearest level, same topic if
possible. Not all 30.

The split is what makes it debuggable. When output drifts, you can tell whether
the guide is wrong (fix the prose) or the exemplars were badly chosen (fix the
selection), instead of staring at a 30-example blob.

## 3. Choosing the 30

Three traps, in the order they will bite:

**Edit whole cards, not scattered sentences.** `defVi`, `leadVi` and
`anticipateVi` have deliberately different registers — a definition, a teaser
that must not name the thing, and a playful invitation. A style guide built from
a mix of all three averages them into mush. 30 *cards* gives you 30 examples of
each field, which is enough per field. If 30 cards is too much work, do 30
`defVi` first and treat the others as a later pass.

**Spread them.** If your 30 are all A1 food nouns, the guide will confidently
tell the model to use kitchen imagery. Aim for roughly even coverage across
levels, and across concrete/abstract — an abstract C1 word is where a voice
shows most, and where a style guide built on apples helps least.

**Include a few you barely touched.** A card you left almost alone is evidence
too: it tells the model the baseline was already right, which stops the guide
from overstating how much everything must change.

## 4. Where it lives in this app

| Piece | Where |
| ----- | ----- |
| The 30 pairs | a `styleSample` flag on `ReviewEntry`, plus the pre-edit text. A star in the review table toggles it. |
| The style guide | a fifth entry in `PROMPT_DEFINITIONS` (`style`), editable on the Prompts tab like the rest |
| Distillation | a one-off action on the Prompts tab: "Rebuild from my samples" |
| Injection | appended to `ANNOTATION_SYSTEM_PROMPT` and `REWRITE_SYSTEM_PROMPT`, after the field rules and before the breaking marks |

Keeping the guide in the prompt store means it is overridable per browser, resets
to a shipped default, and is read by the same `resolvePrompt` everything else
uses. No new machinery.

---

## 5. Prompt A — distillation

Run once over the pairs. The output is what you read and correct.

```text
You are a Vietnamese editor reverse-engineering one writer's voice.

Below are pairs from a vocabulary-card deck. In each pair, BEFORE is what a
general-purpose model wrote and AFTER is what the human editor changed it to.
The content requirement was identical in both: same English word, same field,
same length rules. So every difference between them is a difference of VOICE,
not of task.

Your job is to write the style guide that would have produced the AFTERs.

Work from the evidence, not from what good Vietnamese writing is generally
supposed to look like. If the editor consistently does something a style manual
would frown at, that is a rule, and you must write it down without softening it.

Attend to, in roughly this order:
1. WORD CHOICE. Which words does the editor reach for, and which does the editor
   systematically avoid or replace? Name actual words, in pairs: "prefers X over
   Y". A guide that says "uses natural vocabulary" is worthless.
2. IMAGERY. Concrete or abstract? Sensory or functional? Does a definition tend
   to describe what a thing IS, what it DOES, or what it FEELS like?
3. SENTENCE SHAPE. Where does the sentence put its weight — front, middle, end?
   Does the editor use a pause (a comma, a phrase edge) and where? Short runs or
   one long breath?
4. REGISTER AND ADDRESS. Formal or familiar? Is the reader addressed, implied,
   or absent? Any recurring pronoun or kinship term?
5. WHAT THE EDITOR REMOVES. Often the clearest signal. Filler, hedges,
   nominalisations, stock openers — name the specific things that got deleted.
6. WHAT THE EDITOR LEFT ALONE. If some BEFOREs came through nearly untouched,
   say what they already had right. This bounds the guide.

Write the guide PER FIELD. defVi, leadVi and anticipateVi have different jobs
and the voice differs across them; a rule that only holds for the teaser must
say so.

Rules for the guide itself:
- Every rule must be checkable by looking at one sentence. "Warmer tone" is not
  checkable. "Addresses the reader as 'bạn' in the teaser, never in the
  definition" is.
- Give each rule one BEFORE → AFTER pair from the evidence, quoted exactly.
- Claim nothing you saw once. Mark a rule you saw two or three times as
  TENTATIVE and say so; a human will confirm or cut it.
- Say what you could NOT determine. A short, honest guide beats a padded one,
  and the gaps tell the editor which samples to add next.
- Do not restate the mechanical rules — word counts, the breaking marks `_` `=`
  `|`, the `/…/` highlights, the no-English rule. Those are enforced elsewhere
  and repeating them here wastes the space your observations need.

Return Markdown, no preamble:

## Voice in one paragraph
## defVi
## leadVi
## anticipateVi
## meaningVi
## Across all fields
## Tentative — confirm or cut
## Could not determine from these samples

THE PAIRS:
{{PAIRS}}
```

Each pair rendered as:

```text
── {word} · {field} · {level} · {topics}
BEFORE: {the generated text}
AFTER:  {your edit}
```

## 6. Prompt B — injection

Appended to the annotation and rewrite system prompts. Short on purpose: the
guide is the stable part, the exemplars are the fresh part.

```text
HOUSE VOICE

The deck has one writer and you are standing in for them. The rules above say
what a field must contain; this says how it should sound. Where the two seem to
conflict, the rules above win — but they rarely conflict, and reaching for a
blander phrasing to stay safe is itself a failure.

{{STYLE_GUIDE}}

Examples of the voice, in the field you are writing now. These are finished work
by the writer, not templates: match how they sound, never their subject matter,
and never reuse their phrasing.

{{EXEMPLARS}}

Before you return a field, read it back and ask: would the writer of those
examples have written this? If it reads like competent generic Vietnamese,
it is wrong even when every rule above is satisfied.
```

Exemplars rendered as the bare finals — no BEFOREs here, since at generation
time the contrast is noise:

```text
- {word} ({level}): {your edited text}
```

**Selection, in order:** same field always; then up to 3 sharing a topic with
the word being written; then fill to 6–8 by level proximity; rotate the
tie-breaks so the same three sentences do not anchor every batch.

## 7. Prompt C — the style-diff reviewer

This is the one that answers "which part needs improvement". Hold back 5 of your
30 from the guide, regenerate them, and run this.

```text
You are auditing whether a generated sentence matches a house style.

STYLE GUIDE:
{{STYLE_GUIDE}}

The writer's own version:
{{HUMAN}}

The generated version:
{{MACHINE}}

Both satisfy the mechanical rules. Judge ONLY voice.

For each difference that matters, give:
- which guide rule it relates to, quoted, or NEW RULE if the difference reveals
  something the guide does not cover
- what the writer did
- what the generator did instead
- whether this is the generator missing a rule it was given, or the GUIDE
  failing to state something the writer evidently does

End with one line: GUIDE GAP or GENERATOR MISS, whichever dominates, because
they need different fixes — the first means edit the guide, the second means the
rule is there but not being followed and should be made louder or moved earlier.

No score. A number hides the thing worth reading.
```

That last distinction is the whole point of the harness. Output that is off-voice
is either a guide that does not say the thing, or a guide that says it and is
being ignored. They look identical in the output and have opposite fixes.

---

## 8. Knowing whether it works

Hold out 5 of the 30. Regenerate them, run Prompt C, count GUIDE GAP vs
GENERATOR MISS. Then:

- mostly GUIDE GAP → your samples are teaching more than the guide captured.
  Re-run distillation, or hand-write the missing rule.
- mostly GENERATOR MISS → the guide is right and being ignored. Move the house
  voice block later in the prompt (closer to the output), cut the weakest rules
  so the strong ones are not buried, or raise the exemplar count.
- neither, and the output still feels wrong → the difference is probably not
  expressible as rules. See below.

Re-run it whenever you add samples. It is cheap and it is the only way to tell
the two failure modes apart.

## 9. What will not transfer

Being straight with you, because a harness that promises a voice clone will
disappoint:

**Transfers well.** Vocabulary preferences. Sentence length and rhythm. Register
and how the reader is addressed. Recurring structures. What you habitually
delete. Concrete-versus-abstract instinct.

**Transfers poorly.** Comic timing. Knowing when to break your own rule. Cultural
and regional specificity beyond word choice. Restraint — models over-apply a
style guide, so if your voice is mostly *not* doing things, expect the generator
to overshoot into parody. If that happens, the fix is usually to cut rules, not
add them.

**Will not transfer at all.** Judgement about which sense of a word is worth
teaching. That stays yours.

## 10. Where I expect this to need tuning

Since you asked what to look at critically — the parts I am least confident in:

1. **"Every rule must be checkable" may make the guide too mechanical.** It is
   there to prevent "use a warm tone" uselessness, but voice partly *is* the
   unquantifiable bit. If the guide reads like a checklist and the output reads
   like a checklist, loosen it and allow two or three impressionistic rules.
2. **30 may be too few for per-field guidance**, especially `anticipateVi`,
   which is short and must be unique every time — there is little room for voice
   in 3–8 syllables. Consider spending your 30 on `defVi` and `leadVi` only.
3. **Exemplar count is a guess.** 6–8 is where I would start; if the output
   mimics an exemplar's subject matter instead of its sound, lower it, and make
   the "never their subject matter" line louder.
4. **TENTATIVE rules may not survive contact.** A rule seen twice in 30 samples
   is weak evidence. It might be better to drop them entirely and let the set
   grow, rather than have the human adjudicate noise.
5. **Prompt C has no ground truth.** It judges against the guide, so a rule the
   guide gets wrong will be scored as the generator's fault forever. Your own
   eye stays the final check; the audit narrows where to look, it does not
   replace looking.
