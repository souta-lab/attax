# V12 Explicit-Generator Shadow Corpus

S1 is BLOCKED because `/tmp/redv7-fixed.ts` is absent; no frozen opponent was recreated.

```json
{
  "seeds": [
    1,
    7,
    42,
    3,
    29,
    59
  ],
  "shard": {
    "index": 0,
    "count": 6
  },
  "maxTicks": 12000,
  "configValidation": {
    "fixedSeedCount": 32,
    "uniqueSeedCount": 32,
    "maxTicks": 12000,
    "shard": {
      "index": 0,
      "count": 6,
      "seeds": [
        1,
        7,
        42,
        3,
        29,
        59
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
    "controlS3": "a3ff3e62",
    "candidateS3": "af241d35"
  },
  "aggregates": {
    "control": {
      "matches": 6,
      "wins": 1,
      "caps": 0,
      "ticks": 34536,
      "pieces": 1939,
      "winnerCounts": {
        "left": 1,
        "right": 5,
        "draw": 0,
        "cap": 0
      },
      "left": {
        "lines": 524,
        "sent": 237,
        "tsd": 0,
        "tetris": 1,
        "maxPending": 35,
        "maxHeight": 111,
        "holes": 92,
        "executionSourceMismatches": 0,
        "executionExpectedBoardFailures": 0
      },
      "right": {
        "lines": 542,
        "sent": 277,
        "tsd": 0,
        "tetris": 12,
        "maxPending": 24,
        "maxHeight": 87,
        "holes": 68,
        "executionSourceMismatches": 0,
        "executionExpectedBoardFailures": 0
      }
    },
    "candidate": {
      "matches": 6,
      "wins": 0,
      "caps": 1,
      "ticks": 34680,
      "pieces": 1898,
      "winnerCounts": {
        "left": 0,
        "right": 5,
        "draw": 0,
        "cap": 1
      },
      "left": {
        "lines": 494,
        "sent": 220,
        "tsd": 0,
        "tetris": 2,
        "maxPending": 35,
        "maxHeight": 114,
        "holes": 99,
        "executionSourceMismatches": 0,
        "executionExpectedBoardFailures": 0
      },
      "right": {
        "lines": 542,
        "sent": 269,
        "tsd": 0,
        "tetris": 9,
        "maxPending": 19,
        "maxHeight": 73,
        "holes": 52,
        "executionSourceMismatches": 0,
        "executionExpectedBoardFailures": 0
      }
    }
  },
  "perSeed": [
    {
      "seed": 1,
      "control": {
        "label": "S3",
        "seed": 1,
        "winner": "right",
        "reason": "KO",
        "ticks": 7232,
        "pieces": 407,
        "left": {
          "lines": 118,
          "sent": 60,
          "tsd": 0,
          "tetris": 0,
          "maxPending": 4,
          "maxHeight": 20,
          "holes": 18,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        },
        "right": {
          "lines": 123,
          "sent": 64,
          "tsd": 0,
          "tetris": 2,
          "maxPending": 4,
          "maxHeight": 16,
          "holes": 13,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        }
      },
      "candidate": {
        "label": "S3",
        "seed": 1,
        "winner": "cap",
        "reason": "max-ticks",
        "ticks": 12000,
        "pieces": 656,
        "left": {
          "lines": 176,
          "sent": 84,
          "tsd": 0,
          "tetris": 0,
          "maxPending": 4,
          "maxHeight": 14,
          "holes": 10,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        },
        "right": {
          "lines": 191,
          "sent": 72,
          "tsd": 0,
          "tetris": 2,
          "maxPending": 5,
          "maxHeight": 16,
          "holes": 13,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        }
      }
    },
    {
      "seed": 7,
      "control": {
        "label": "S3",
        "seed": 7,
        "winner": "right",
        "reason": "KO",
        "ticks": 10792,
        "pieces": 605,
        "left": {
          "lines": 168,
          "sent": 73,
          "tsd": 0,
          "tetris": 1,
          "maxPending": 5,
          "maxHeight": 20,
          "holes": 16,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        },
        "right": {
          "lines": 173,
          "sent": 81,
          "tsd": 0,
          "tetris": 4,
          "maxPending": 4,
          "maxHeight": 14,
          "holes": 11,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        }
      },
      "candidate": {
        "label": "S3",
        "seed": 7,
        "winner": "right",
        "reason": "KO",
        "ticks": 7440,
        "pieces": 410,
        "left": {
          "lines": 109,
          "sent": 54,
          "tsd": 0,
          "tetris": 2,
          "maxPending": 5,
          "maxHeight": 20,
          "holes": 19,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        },
        "right": {
          "lines": 119,
          "sent": 54,
          "tsd": 0,
          "tetris": 1,
          "maxPending": 5,
          "maxHeight": 13,
          "holes": 12,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        }
      }
    },
    {
      "seed": 42,
      "control": {
        "label": "S3",
        "seed": 42,
        "winner": "right",
        "reason": "KO",
        "ticks": 5248,
        "pieces": 293,
        "left": {
          "lines": 76,
          "sent": 41,
          "tsd": 0,
          "tetris": 0,
          "maxPending": 5,
          "maxHeight": 20,
          "holes": 16,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        },
        "right": {
          "lines": 85,
          "sent": 45,
          "tsd": 0,
          "tetris": 0,
          "maxPending": 4,
          "maxHeight": 16,
          "holes": 13,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        }
      },
      "candidate": {
        "label": "S3",
        "seed": 42,
        "winner": "right",
        "reason": "KO",
        "ticks": 2528,
        "pieces": 139,
        "left": {
          "lines": 30,
          "sent": 13,
          "tsd": 0,
          "tetris": 0,
          "maxPending": 5,
          "maxHeight": 20,
          "holes": 16,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        },
        "right": {
          "lines": 40,
          "sent": 26,
          "tsd": 0,
          "tetris": 0,
          "maxPending": 2,
          "maxHeight": 9,
          "holes": 5,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        }
      }
    },
    {
      "seed": 3,
      "control": {
        "label": "S3",
        "seed": 3,
        "winner": "right",
        "reason": "KO",
        "ticks": 5424,
        "pieces": 308,
        "left": {
          "lines": 81,
          "sent": 20,
          "tsd": 0,
          "tetris": 0,
          "maxPending": 5,
          "maxHeight": 20,
          "holes": 18,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        },
        "right": {
          "lines": 77,
          "sent": 43,
          "tsd": 0,
          "tetris": 3,
          "maxPending": 2,
          "maxHeight": 9,
          "holes": 4,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        }
      },
      "candidate": {
        "label": "S3",
        "seed": 3,
        "winner": "right",
        "reason": "KO",
        "ticks": 1280,
        "pieces": 70,
        "left": {
          "lines": 12,
          "sent": 4,
          "tsd": 0,
          "tetris": 0,
          "maxPending": 5,
          "maxHeight": 20,
          "holes": 15,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        },
        "right": {
          "lines": 18,
          "sent": 17,
          "tsd": 0,
          "tetris": 2,
          "maxPending": 1,
          "maxHeight": 9,
          "holes": 2,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        }
      }
    },
    {
      "seed": 29,
      "control": {
        "label": "S3",
        "seed": 29,
        "winner": "left",
        "reason": "KO",
        "ticks": 2336,
        "pieces": 131,
        "left": {
          "lines": 35,
          "sent": 23,
          "tsd": 0,
          "tetris": 0,
          "maxPending": 5,
          "maxHeight": 11,
          "holes": 6,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        },
        "right": {
          "lines": 29,
          "sent": 12,
          "tsd": 0,
          "tetris": 2,
          "maxPending": 6,
          "maxHeight": 20,
          "holes": 17,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        }
      },
      "candidate": {
        "label": "S3",
        "seed": 29,
        "winner": "right",
        "reason": "KO",
        "ticks": 7928,
        "pieces": 428,
        "left": {
          "lines": 121,
          "sent": 45,
          "tsd": 0,
          "tetris": 0,
          "maxPending": 5,
          "maxHeight": 20,
          "holes": 21,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        },
        "right": {
          "lines": 119,
          "sent": 68,
          "tsd": 0,
          "tetris": 3,
          "maxPending": 2,
          "maxHeight": 14,
          "holes": 10,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        }
      }
    },
    {
      "seed": 59,
      "control": {
        "label": "S3",
        "seed": 59,
        "winner": "right",
        "reason": "KO",
        "ticks": 3504,
        "pieces": 195,
        "left": {
          "lines": 46,
          "sent": 20,
          "tsd": 0,
          "tetris": 0,
          "maxPending": 11,
          "maxHeight": 20,
          "holes": 18,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        },
        "right": {
          "lines": 55,
          "sent": 32,
          "tsd": 0,
          "tetris": 1,
          "maxPending": 4,
          "maxHeight": 12,
          "holes": 10,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        }
      },
      "candidate": {
        "label": "S3",
        "seed": 59,
        "winner": "right",
        "reason": "KO",
        "ticks": 3504,
        "pieces": 195,
        "left": {
          "lines": 46,
          "sent": 20,
          "tsd": 0,
          "tetris": 0,
          "maxPending": 11,
          "maxHeight": 20,
          "holes": 18,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        },
        "right": {
          "lines": 55,
          "sent": 32,
          "tsd": 0,
          "tetris": 1,
          "maxPending": 4,
          "maxHeight": 12,
          "holes": 10,
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
seed order  1 7 42 3 29 59
control     R R R R L R
candidate   C R R R R R
```
