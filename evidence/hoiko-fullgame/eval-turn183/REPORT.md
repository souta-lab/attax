# E4 eval differential — turn 183 (`EvaluateAI.Evaluate`/`EvaluateFirst`)

## Headline

Every compared node's `score`, `familyScore` and all sub-terms are **identical** between the shipping `Hoiko.exe` and the Rust/WASM replica: both 14-ply chosen lines (594 and 619 nodes through depth 14) and the full depth-2 breadth (all 68 gen-1 states, 3654 nodes).
Running the exe's exact `std::partial_sort` beam policy (transcribed from IL 16239/16367/16455/16509) on the replica's identical evaluation scores reproduces the exe **exactly**: move x=7 rot=2 m=2, nodeCount=64174, and 14/14 plan plies. Leaf evaluation is not the divergence; beam tie-breaking is (H3).

Exe search: nodeCount=64174, depth=14, plan=14 plies.
Replica trace (replica policy): x=7 r=0 m=2 hold=0 score=716 depth=14 nodes=63854 (TRACE_MATCH acc. to replica's own comparator = 0).
Replica trace (exe std::partial_sort policy): x=7 r=2 m=2 hold=0 score=79 depth=14 nodes=64174.

Exe plan: `7:2:2:0,4:3:4:0,0:3:6:0,4:1:0:4,7:0:-1:-1,3:3:5:0,1:1:1:0,0:3:6:0,7:1:5:0,3:0:3:0,5:2:4:6,6:1:1:0,8:3:2:0,3:0:3:0`

Replica plan: `7:0:2:0,5:2:4:6,0:3:6:0,7:0:5:0,-1:1:4:0,3:0:3:0,2:0:1:0,2:0:6:0,3:1:5:0,5:2:4:6,7:0:3:0,6:1:1:0,1:0:2:0,4:1:0:4`

std::partial_sort plan: `7:2:2:0,4:3:4:0,0:3:6:0,4:1:0:4,7:0:4:0,3:3:5:0,1:1:1:0,0:3:6:0,7:1:5:0,3:0:3:0,5:2:4:6,6:1:1:0,8:3:2:0,3:0:3:0`

- All 14 plan plies reproduced (drawingBreak entries compared on x/rot only).

## Beam-cutoff tie exposure (replica search)

| depth | children | cap | keep | cutoff score | at cutoff | kept at cutoff |
|------:|---------:|----:|-----:|-------------:|----------:|---------------:|
| 2 | 3586 | 150 | 150 | -257 | 1 | 1 |
| 3 | 5826 | 150 | 150 | -229 | 1 | 1 |
| 4 | 5250 | 150 | 150 | -86 | 2 | 2 |
| 5 | 7778 | 150 | 150 | -59 | 6 | 5 |
| 6 | 5440 | 150 | 150 | -61 | 7 | 2 |
| 7 | 9238 | 150 | 150 | -49 | 4 | 2 |
| 8 | 7231 | 75 | 75 | -33 | 6 | 6 |
| 9 | 3448 | 75 | 75 | -44 | 5 | 5 |
| 10 | 3361 | 75 | 75 | -89 | 3 | 3 |
| 11 | 2596 | 75 | 75 | 22 | 3 | 2 |
| 12 | 3455 | 75 | 75 | 121 | 4 | 4 |
| 13 | 3952 | 75 | 75 | 165 | 2 | 2 |

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
State-mismatch containers: none.

## replica-path

Nodes compared: exe=619, replica=619.
Eval-mismatch containers: none.
State-mismatch containers: none.

## bfs-depth2

Nodes compared: exe=3654, replica=3654.
Eval-mismatch containers: none.
State-mismatch containers: none.

