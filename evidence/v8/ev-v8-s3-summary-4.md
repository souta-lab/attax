# V12 Explicit-Generator Shadow Corpus

S1 is BLOCKED because `/tmp/redv7-fixed.ts` is absent; no frozen opponent was recreated.

```json
{
  "seeds": [
    61,
    67,
    71,
    777,
    11
  ],
  "shard": {
    "index": 4,
    "count": 6
  },
  "maxTicks": 12000,
  "configValidation": {
    "fixedSeedCount": 32,
    "uniqueSeedCount": 32,
    "maxTicks": 12000,
    "shard": {
      "index": 4,
      "count": 6,
      "seeds": [
        61,
        67,
        71,
        777,
        11
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
    "controlS3": "25a63b43",
    "candidateS3": "caa2171d"
  },
  "aggregates": {
    "control": {
      "matches": 5,
      "wins": 2,
      "caps": 0,
      "ticks": 28008,
      "pieces": 1566,
      "winnerCounts": {
        "left": 2,
        "right": 3,
        "draw": 0,
        "cap": 0
      },
      "left": {
        "lines": 431,
        "sent": 219,
        "tsd": 0,
        "tetris": 2,
        "maxPending": 21,
        "maxHeight": 89,
        "holes": 75,
        "executionSourceMismatches": 0,
        "executionExpectedBoardFailures": 0
      },
      "right": {
        "lines": 437,
        "sent": 226,
        "tsd": 0,
        "tetris": 10,
        "maxPending": 22,
        "maxHeight": 78,
        "holes": 60,
        "executionSourceMismatches": 0,
        "executionExpectedBoardFailures": 0
      }
    },
    "candidate": {
      "matches": 5,
      "wins": 0,
      "caps": 1,
      "ticks": 26208,
      "pieces": 1453,
      "winnerCounts": {
        "left": 0,
        "right": 4,
        "draw": 0,
        "cap": 1
      },
      "left": {
        "lines": 380,
        "sent": 162,
        "tsd": 0,
        "tetris": 3,
        "maxPending": 21,
        "maxHeight": 92,
        "holes": 76,
        "executionSourceMismatches": 0,
        "executionExpectedBoardFailures": 0
      },
      "right": {
        "lines": 398,
        "sent": 207,
        "tsd": 0,
        "tetris": 12,
        "maxPending": 18,
        "maxHeight": 63,
        "holes": 36,
        "executionSourceMismatches": 0,
        "executionExpectedBoardFailures": 0
      }
    }
  },
  "perSeed": [
    {
      "seed": 61,
      "control": {
        "label": "S3",
        "seed": 61,
        "winner": "right",
        "reason": "KO",
        "ticks": 3688,
        "pieces": 211,
        "left": {
          "lines": 57,
          "sent": 29,
          "tsd": 0,
          "tetris": 0,
          "maxPending": 4,
          "maxHeight": 20,
          "holes": 17,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        },
        "right": {
          "lines": 62,
          "sent": 37,
          "tsd": 0,
          "tetris": 1,
          "maxPending": 4,
          "maxHeight": 16,
          "holes": 9,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        }
      },
      "candidate": {
        "label": "S3",
        "seed": 61,
        "winner": "right",
        "reason": "KO",
        "ticks": 3688,
        "pieces": 211,
        "left": {
          "lines": 57,
          "sent": 29,
          "tsd": 0,
          "tetris": 0,
          "maxPending": 4,
          "maxHeight": 20,
          "holes": 17,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        },
        "right": {
          "lines": 62,
          "sent": 37,
          "tsd": 0,
          "tetris": 1,
          "maxPending": 4,
          "maxHeight": 16,
          "holes": 9,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        }
      }
    },
    {
      "seed": 67,
      "control": {
        "label": "S3",
        "seed": 67,
        "winner": "right",
        "reason": "KO",
        "ticks": 3312,
        "pieces": 188,
        "left": {
          "lines": 42,
          "sent": 15,
          "tsd": 0,
          "tetris": 1,
          "maxPending": 4,
          "maxHeight": 20,
          "holes": 16,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        },
        "right": {
          "lines": 48,
          "sent": 24,
          "tsd": 0,
          "tetris": 1,
          "maxPending": 4,
          "maxHeight": 10,
          "holes": 5,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        }
      },
      "candidate": {
        "label": "S3",
        "seed": 67,
        "winner": "right",
        "reason": "KO",
        "ticks": 3312,
        "pieces": 188,
        "left": {
          "lines": 42,
          "sent": 15,
          "tsd": 0,
          "tetris": 1,
          "maxPending": 4,
          "maxHeight": 20,
          "holes": 16,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        },
        "right": {
          "lines": 48,
          "sent": 24,
          "tsd": 0,
          "tetris": 1,
          "maxPending": 4,
          "maxHeight": 10,
          "holes": 5,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        }
      }
    },
    {
      "seed": 71,
      "control": {
        "label": "S3",
        "seed": 71,
        "winner": "left",
        "reason": "KO",
        "ticks": 4736,
        "pieces": 263,
        "left": {
          "lines": 79,
          "sent": 52,
          "tsd": 0,
          "tetris": 1,
          "maxPending": 4,
          "maxHeight": 13,
          "holes": 13,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        },
        "right": {
          "lines": 75,
          "sent": 35,
          "tsd": 0,
          "tetris": 1,
          "maxPending": 6,
          "maxHeight": 20,
          "holes": 19,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        }
      },
      "candidate": {
        "label": "S3",
        "seed": 71,
        "winner": "right",
        "reason": "KO",
        "ticks": 5064,
        "pieces": 276,
        "left": {
          "lines": 80,
          "sent": 41,
          "tsd": 0,
          "tetris": 1,
          "maxPending": 4,
          "maxHeight": 19,
          "holes": 15,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        },
        "right": {
          "lines": 84,
          "sent": 53,
          "tsd": 0,
          "tetris": 1,
          "maxPending": 4,
          "maxHeight": 15,
          "holes": 11,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        }
      }
    },
    {
      "seed": 777,
      "control": {
        "label": "S3",
        "seed": 777,
        "winner": "left",
        "reason": "KO",
        "ticks": 4552,
        "pieces": 255,
        "left": {
          "lines": 74,
          "sent": 45,
          "tsd": 0,
          "tetris": 0,
          "maxPending": 5,
          "maxHeight": 16,
          "holes": 13,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        },
        "right": {
          "lines": 68,
          "sent": 37,
          "tsd": 0,
          "tetris": 5,
          "maxPending": 5,
          "maxHeight": 20,
          "holes": 19,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        }
      },
      "candidate": {
        "label": "S3",
        "seed": 777,
        "winner": "right",
        "reason": "KO",
        "ticks": 2144,
        "pieces": 118,
        "left": {
          "lines": 25,
          "sent": 9,
          "tsd": 0,
          "tetris": 0,
          "maxPending": 5,
          "maxHeight": 20,
          "holes": 18,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        },
        "right": {
          "lines": 27,
          "sent": 20,
          "tsd": 0,
          "tetris": 3,
          "maxPending": 2,
          "maxHeight": 11,
          "holes": 4,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        }
      }
    },
    {
      "seed": 11,
      "control": {
        "label": "S3",
        "seed": 11,
        "winner": "right",
        "reason": "KO",
        "ticks": 11720,
        "pieces": 649,
        "left": {
          "lines": 179,
          "sent": 78,
          "tsd": 0,
          "tetris": 0,
          "maxPending": 4,
          "maxHeight": 20,
          "holes": 16,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        },
        "right": {
          "lines": 184,
          "sent": 93,
          "tsd": 0,
          "tetris": 2,
          "maxPending": 3,
          "maxHeight": 12,
          "holes": 8,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        }
      },
      "candidate": {
        "label": "S3",
        "seed": 11,
        "winner": "cap",
        "reason": "max-ticks",
        "ticks": 12000,
        "pieces": 660,
        "left": {
          "lines": 176,
          "sent": 68,
          "tsd": 0,
          "tetris": 1,
          "maxPending": 4,
          "maxHeight": 13,
          "holes": 10,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        },
        "right": {
          "lines": 177,
          "sent": 73,
          "tsd": 0,
          "tetris": 6,
          "maxPending": 4,
          "maxHeight": 11,
          "holes": 7,
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
seed order  61 67 71 777 11
control     R R L L R
candidate   R R R R C
```
