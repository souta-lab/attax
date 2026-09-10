# V12 Explicit-Generator Shadow Corpus

S1 is BLOCKED because `/tmp/redv7-fixed.ts` is absent; no frozen opponent was recreated.

```json
{
  "seeds": [
    13,
    17,
    19,
    47,
    79
  ],
  "shard": {
    "index": 2,
    "count": 6
  },
  "maxTicks": 12000,
  "configValidation": {
    "fixedSeedCount": 32,
    "uniqueSeedCount": 32,
    "maxTicks": 12000,
    "shard": {
      "index": 2,
      "count": 6,
      "seeds": [
        13,
        17,
        19,
        47,
        79
      ]
    },
    "s1": {
      "status": "BLOCKED",
      "opponentPath": "/tmp/redv7-fixed.ts",
      "sourcePresent": false,
      "reason": "S1 blocked: /tmp/redv7-fixed.ts is absent; no frozen opponent was recreated"
    },
    "control": "createFighterA({useKick:false})",
    "candidate": "createFighterA({placementGenerator: explicitKickGenerator})",
    "opponent": "live createFighterB()"
  },
  "fingerprints": {
    "controlS3": "7a1c44b1",
    "candidateS3": "5a67b1cb"
  },
  "aggregates": {
    "control": {
      "matches": 5,
      "wins": 0,
      "caps": 1,
      "ticks": 37848,
      "pieces": 2126,
      "winnerCounts": {
        "left": 0,
        "right": 4,
        "draw": 0,
        "cap": 1
      },
      "left": {
        "lines": 575,
        "sent": 254,
        "tsd": 0,
        "tetris": 3,
        "maxPending": 39,
        "maxHeight": 93,
        "holes": 85,
        "executionSourceMismatches": 0,
        "executionExpectedBoardFailures": 0
      },
      "right": {
        "lines": 595,
        "sent": 296,
        "tsd": 0,
        "tetris": 14,
        "maxPending": 22,
        "maxHeight": 61,
        "holes": 39,
        "executionSourceMismatches": 0,
        "executionExpectedBoardFailures": 0
      }
    },
    "candidate": {
      "matches": 5,
      "wins": 2,
      "caps": 0,
      "ticks": 32416,
      "pieces": 1813,
      "winnerCounts": {
        "left": 2,
        "right": 3,
        "draw": 0,
        "cap": 0
      },
      "left": {
        "lines": 485,
        "sent": 244,
        "tsd": 0,
        "tetris": 6,
        "maxPending": 25,
        "maxHeight": 86,
        "holes": 69,
        "executionSourceMismatches": 0,
        "executionExpectedBoardFailures": 0
      },
      "right": {
        "lines": 509,
        "sent": 232,
        "tsd": 0,
        "tetris": 12,
        "maxPending": 25,
        "maxHeight": 80,
        "holes": 62,
        "executionSourceMismatches": 0,
        "executionExpectedBoardFailures": 0
      }
    }
  },
  "perSeed": [
    {
      "seed": 13,
      "control": {
        "label": "S3",
        "seed": 13,
        "winner": "cap",
        "reason": "max-ticks",
        "ticks": 12000,
        "pieces": 679,
        "left": {
          "lines": 192,
          "sent": 86,
          "tsd": 0,
          "tetris": 2,
          "maxPending": 10,
          "maxHeight": 15,
          "holes": 12,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        },
        "right": {
          "lines": 196,
          "sent": 93,
          "tsd": 0,
          "tetris": 3,
          "maxPending": 4,
          "maxHeight": 15,
          "holes": 12,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        }
      },
      "candidate": {
        "label": "S3",
        "seed": 13,
        "winner": "right",
        "reason": "KO",
        "ticks": 8600,
        "pieces": 483,
        "left": {
          "lines": 126,
          "sent": 53,
          "tsd": 0,
          "tetris": 2,
          "maxPending": 4,
          "maxHeight": 20,
          "holes": 13,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        },
        "right": {
          "lines": 141,
          "sent": 66,
          "tsd": 0,
          "tetris": 2,
          "maxPending": 4,
          "maxHeight": 15,
          "holes": 12,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        }
      }
    },
    {
      "seed": 17,
      "control": {
        "label": "S3",
        "seed": 17,
        "winner": "right",
        "reason": "KO",
        "ticks": 5592,
        "pieces": 311,
        "left": {
          "lines": 71,
          "sent": 31,
          "tsd": 0,
          "tetris": 0,
          "maxPending": 4,
          "maxHeight": 19,
          "holes": 23,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        },
        "right": {
          "lines": 81,
          "sent": 33,
          "tsd": 0,
          "tetris": 3,
          "maxPending": 3,
          "maxHeight": 10,
          "holes": 8,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        }
      },
      "candidate": {
        "label": "S3",
        "seed": 17,
        "winner": "left",
        "reason": "KO",
        "ticks": 4704,
        "pieces": 256,
        "left": {
          "lines": 66,
          "sent": 40,
          "tsd": 0,
          "tetris": 1,
          "maxPending": 4,
          "maxHeight": 16,
          "holes": 11,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        },
        "right": {
          "lines": 64,
          "sent": 25,
          "tsd": 0,
          "tetris": 4,
          "maxPending": 4,
          "maxHeight": 20,
          "holes": 17,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        }
      }
    },
    {
      "seed": 19,
      "control": {
        "label": "S3",
        "seed": 19,
        "winner": "right",
        "reason": "KO",
        "ticks": 5448,
        "pieces": 304,
        "left": {
          "lines": 78,
          "sent": 33,
          "tsd": 0,
          "tetris": 0,
          "maxPending": 10,
          "maxHeight": 20,
          "holes": 18,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        },
        "right": {
          "lines": 81,
          "sent": 46,
          "tsd": 0,
          "tetris": 2,
          "maxPending": 5,
          "maxHeight": 11,
          "holes": 4,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        }
      },
      "candidate": {
        "label": "S3",
        "seed": 19,
        "winner": "left",
        "reason": "KO",
        "ticks": 4808,
        "pieces": 269,
        "left": {
          "lines": 72,
          "sent": 53,
          "tsd": 0,
          "tetris": 2,
          "maxPending": 2,
          "maxHeight": 12,
          "holes": 9,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        },
        "right": {
          "lines": 78,
          "sent": 26,
          "tsd": 0,
          "tetris": 0,
          "maxPending": 7,
          "maxHeight": 20,
          "holes": 18,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        }
      }
    },
    {
      "seed": 47,
      "control": {
        "label": "S3",
        "seed": 47,
        "winner": "right",
        "reason": "KO",
        "ticks": 11264,
        "pieces": 630,
        "left": {
          "lines": 184,
          "sent": 87,
          "tsd": 0,
          "tetris": 1,
          "maxPending": 11,
          "maxHeight": 20,
          "holes": 16,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        },
        "right": {
          "lines": 184,
          "sent": 93,
          "tsd": 0,
          "tetris": 4,
          "maxPending": 4,
          "maxHeight": 13,
          "holes": 9,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        }
      },
      "candidate": {
        "label": "S3",
        "seed": 47,
        "winner": "right",
        "reason": "KO",
        "ticks": 10760,
        "pieces": 603,
        "left": {
          "lines": 171,
          "sent": 81,
          "tsd": 0,
          "tetris": 1,
          "maxPending": 11,
          "maxHeight": 19,
          "holes": 20,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        },
        "right": {
          "lines": 173,
          "sent": 84,
          "tsd": 0,
          "tetris": 4,
          "maxPending": 4,
          "maxHeight": 13,
          "holes": 9,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        }
      }
    },
    {
      "seed": 79,
      "control": {
        "label": "S3",
        "seed": 79,
        "winner": "right",
        "reason": "KO",
        "ticks": 3544,
        "pieces": 202,
        "left": {
          "lines": 50,
          "sent": 17,
          "tsd": 0,
          "tetris": 0,
          "maxPending": 4,
          "maxHeight": 19,
          "holes": 16,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        },
        "right": {
          "lines": 53,
          "sent": 31,
          "tsd": 0,
          "tetris": 2,
          "maxPending": 6,
          "maxHeight": 12,
          "holes": 6,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        }
      },
      "candidate": {
        "label": "S3",
        "seed": 79,
        "winner": "right",
        "reason": "KO",
        "ticks": 3544,
        "pieces": 202,
        "left": {
          "lines": 50,
          "sent": 17,
          "tsd": 0,
          "tetris": 0,
          "maxPending": 4,
          "maxHeight": 19,
          "holes": 16,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        },
        "right": {
          "lines": 53,
          "sent": 31,
          "tsd": 0,
          "tetris": 2,
          "maxPending": 6,
          "maxHeight": 12,
          "holes": 6,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        }
      }
    }
  ],
  "decision": "PASS: zero candidate expected-board failures"
}
```

## ASCII Metric Brain

This is an ASCII metric render, not a board render.

```text
ASCII METRIC BRAIN (not a board render)
seed order  13 17 19 47 79
control     C R R R R
candidate   R L L R R
```
