# Attax paper (draft v1)

This directory holds a draft academic-style paper about Attax: its architecture,
its measured results under guideline versus rules, and a case study of its
so-far unsuccessful campaign under the S2 ruleset, where two pre-registered
weight-tuning campaigns failed and a subsequent audit traced the failure to
divergences between the bot's internal world model and the referee. Status:
**draft v1** (November 2026), not yet submitted anywhere. Every score in the
paper was regenerated from `bench-results/*.jsonl` with the repository's
results generator (`bun run results`, `scripts/build-results.ts`); figures
that come from campaign record files instead are cited to those files in the
paper's provenance notes. No unpublished result is presented as an
achievement, and no S2 win is claimed.
