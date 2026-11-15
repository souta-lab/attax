# Attax paper (draft v2)

This directory holds a draft academic-style paper about Attax: its architecture,
its measured results under guideline versus rules, and a case study of its
so-far unsuccessful campaign under the S2 ruleset, where two pre-registered
weight-tuning campaigns failed and a subsequent audit traced the failure to
divergences between the bot's internal world model and the referee. Status:
**draft v2** (November 2026), not yet submitted anywhere. Every score in the
paper was regenerated from `bench-results/*.jsonl` with the repository's
results generator (`bun run results`, `scripts/build-results.ts`); figures
that come from campaign record files instead are cited to those files in the
paper's provenance notes. No unpublished result is presented as an
achievement, and no S2 win is claimed.

## PDF

The typeset PDF lives at the repository root as `attax-paper.pdf`
(11 pages, draft v2). It is built from `main.md` — the Markdown is the
source of truth; `main.tex` is generated and committed so the exact
typeset source is inspectable. Build command (from the repository
root):

```
python3 paper/build.py
```

Requires pandoc 3.14 and a TeX Live installation with LuaLaTeX
(`~/texlive/bin/x86_64-linux` on `PATH`). The script lifts the
title/author/abstract into pandoc metadata, converts the manually
numbered display equations into `equation` environments, normalizes
text-mode unicode, compiles three LuaLaTeX passes, and copies the
result to `attax-paper.pdf`.
