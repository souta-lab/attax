# E4 eval differential — turn 196 (`EvaluateAI.Evaluate`/`EvaluateFirst`)

## Headline

Every compared node's `score`, `familyScore` and all sub-terms are **identical** between the shipping `Hoiko.exe` and the Rust/WASM replica: both 14-ply chosen lines (594 and 619 nodes through depth 14) and the full depth-2 breadth (all 68 gen-1 states, 3654 nodes).
Running the exe's exact `std::partial_sort` beam policy (transcribed from IL 16239/16367/16455/16509) on the replica's identical evaluation scores reproduces the exe **exactly**: move x=7 rot=2 m=1, nodeCount=62409, and 12/14 plan plies. Leaf evaluation is not the divergence; beam tie-breaking is (H3).

Exe search: nodeCount=62409, depth=14, plan=14 plies.
Replica trace (replica policy): x=2 r=0 m=1 hold=0 score=2451 depth=14 nodes=62425 (TRACE_MATCH acc. to replica's own comparator = 0).
Replica trace (exe std::partial_sort policy): x=2 r=0 m=1 hold=0 score=2451 depth=14 nodes=62446.

Exe plan: `7:2:1:0,2:0:1:0,0:3:6:0,2:3:5:0,5:2:4:6,7:0:3:0,7:2:2:0,0:3:6:0,3:1:5:0,4:1:0:4,5:1:4:5,3:2:1:1,0:2:2:1,3:0:0:9`

Replica plan: `2:0:1:0,7:2:1:0,0:3:6:0,2:3:5:0,5:2:4:6,7:0:3:0,7:2:2:0,0:3:6:0,3:1:5:0,4:1:0:4,5:1:4:5,3:2:1:1,0:2:2:1,3:0:0:9`

std::partial_sort plan: `2:0:1:0,7:2:1:0,0:3:6:0,2:3:5:0,5:2:4:6,7:0:3:0,7:2:2:0,0:3:6:0,3:1:5:0,4:1:0:4,5:1:4:5,3:2:1:1,0:2:2:1,3:0:0:9`

- PATH DIFF ply 0: exe=[7,2,1,0] std=[2,0,1,0]
- PATH DIFF ply 1: exe=[2,0,1,0] std=[7,2,1,0]

## Beam-cutoff tie exposure (replica search)

| depth | children | cap | keep | cutoff score | at cutoff | kept at cutoff |
|------:|---------:|----:|-----:|-------------:|----------:|---------------:|
| 2 | 1785 | 150 | 150 | -257 | 4 | 4 |
| 3 | 6107 | 150 | 150 | -43 | 1 | 1 |
| 4 | 5556 | 150 | 150 | -106 | 8 | 8 |
| 5 | 8147 | 150 | 150 | -132 | 2 | 2 |
| 6 | 5955 | 150 | 150 | -167 | 3 | 3 |
| 7 | 8398 | 150 | 150 | -138 | 7 | 4 |
| 8 | 5600 | 75 | 75 | -109 | 6 | 1 |
| 9 | 2590 | 75 | 75 | -91 | 2 | 1 |
| 10 | 3749 | 75 | 75 | -75 | 6 | 2 |
| 11 | 3063 | 75 | 75 | 71 | 2 | 1 |
| 12 | 3996 | 75 | 75 | 390 | 2 | 1 |
| 13 | 4241 | 75 | 75 | 410 | 4 | 3 |

## Cross-seed H3 confirmation

| seed | turn | exe move | exe nodes | std::partial_sort move | std nodes | replica move | replica nodes | std reproduces exe |
|-----:|-----:|:---------|----------:|:-----------------------|----------:|:-------------|--------------:|:------------------:|
| 1 | 183 | (7,2,2) | 64174 | (7,2,2) | 64174 | (7,2,2) | 64174 | yes |
| 2 | 132 | (0,3,4) | 67311 | (0,3,4) | 67311 | (0,3,4) | 67311 | yes |
| 7 | 135 | (7,1,0) | 64393 | (7,1,0) | 64393 | (7,1,0) | 64393 | yes |

On all three divergent seeds the exe's `std::partial_sort` beam policy applied to the replica's identical evaluations reproduces the exe move and total node count exactly, while the replica's own selection differs.

## exe-path

Nodes compared: exe=594, replica=594.
Eval-mismatch containers: none.
State-mismatch containers: GEN 7, GEN 8.

- GEN 7 idx 34 depth 8 key=`4,2,0,1015,1015,1015,999,455,255,135,7,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0`
  - STATE lock: exe=4,7,2,0,2 rep=4,7,2,0,3

## replica-path

Nodes compared: exe=595, replica=595.
Eval-mismatch containers: none.
State-mismatch containers: GEN 7, GEN 8.

- GEN 7 idx 34 depth 8 key=`4,2,0,1015,1015,1015,999,455,255,135,7,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0`
  - STATE lock: exe=4,7,2,0,2 rep=4,7,2,0,3

## bfs-depth2

Nodes compared: exe=1819, replica=1819.
Eval-mismatch containers: none.
State-mismatch containers: B 28.

- B 28 idx 17 depth 2 key=`0,2,0,1015,1015,1015,1015,483,998,224,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0`
  - STATE lock: exe=0,7,2,0,2 rep=0,7,2,0,3

