# Attax vs intetrigence — worked TBP example

The original local match report (2026-11-13, supplied with this packaging task)
recorded Attax 100–0 intetrigence: held-out seeds 5001–5050, both seats.
Across 14,230 Attax moves it reported no errors and no fallbacks; every first
suggestion was accepted. These are historical results, not a new packaging benchmark.
The original replay artefacts are not bundled in this repository.

The host was intetrigence e816913 with Guideline rules, five previews, hold,
100 ms nominal local search and 5 PPS. Attax used its default fixed-work search
(preview 5, beam width 48), without a time limit in the non-strict external mode.
This was not an equal-time-budget comparison. The adapter received no pending
garbage and exposed only the bottom 20 rows; the original report recorded no
turns with cells above that view.

With a locally built referee, the equivalent command using the packaged adapter is:

```sh
ATTAX_TBP_LOG="$PWD/attax-decisions.jsonl" /path/to/intetrigence external-arena \
  --rules guideline --opponent "$PWD/tbp/attax-tbp.sh" \
  --games 100 --seed 5001 --ms 100 --pps 5 --turns 1000 \
  --output match.json --replay match.jsonl
/path/to/intetrigence verify-replay --input match.jsonl
```

Run this from the Attax repository root. intetrigence's replay calls the external
player `cold_clear_2`; with this opponent path that label means Attax.
Its summary wins/losses are from intetrigence's perspective.

For a short automated check of the maintained adapter, use
`python3 tbp/smoke.py /path/to/intetrigence`. It checks accepted moves against
the decision log and verifies the replay, rather than relying on the scoreline.
