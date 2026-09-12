# E3 expand differential — turn 196

Exe search: nodeCount=62409, depth=14, plan=14 entries (0 display breaks).

| gen | exe | replica | safe | count | set | order |
|----:|----:|--------:|-----:|:-----:|:---:|:-----:|
| 0 | 34 | 34 | 1 | ok | ok | ok |
| 1 | 51 | 51 | 1 | ok | ok | ok |
| 2 | 35 | 35 | 1 | ok | ok | ok |
| 3 | 34 | 34 | 1 | ok | ok | ok |
| 4 | 54 | 54 | 1 | ok | ok | ok |
| 5 | 26 | 26 | 1 | ok | ok | ok |
| 6 | 51 | 51 | 1 | ok | ok | ok |
| 7 | 35 | 35 | 1 | ok | ok | ok |
| 8 | 36 | 36 | 1 | ok | ok | ok |
| 9 | 54 | 54 | 1 | ok | ok | ok |
| 10 | 46 | 46 | 1 | ok | ok | ok |
| 11 | 43 | 43 | 1 | ok | ok | ok |
| 12 | 43 | 43 | 1 | ok | ok | ok |
| 13 | 26 | 26 | 1 | ok | ok | ok |
| 14 | 26 | 26 | 1 | ok | ok | ok |

No child-set mismatch along the exe's chosen line.
## Depth-2 breadth (all 68 gen-1 states)

- Exe total children at depth 2: 1785; replica: 1785.
- Unsafe positions: 0; unsafe with childCount>34 (H1 prune active): 0.
- All 68 depth-1 state child sets match (count, set, order).

## Synthetic H1/H2 fuzz

- Positions: 48.
- Exe total children: 1892; replica: 1892.
- Unsafe positions: 20; unsafe with childCount>34 (H1 prune active): 7.
- First mismatch: position 8 (tall#2); exe=24, replica=24, safe=0.

## Verdict

- No missing or extra child boards anywhere: counts and final boards match along the exe's chosen line, across all 68 depth-1 states, and across the 48-state H1/H2 fuzz.
- H1 (`get_filtered_count`) and H2 (derive BFS) are not evidenced as causes of the turn-183 divergence; the node-count difference must come from different beam membership (evaluation/tie-break), not from child generation.
- 2/48 fuzz positions differ only in which equal-delay duplicate placement representative survives dedup (same final boards; e.g. pos 8); these are label/order differences, not missing boards.

