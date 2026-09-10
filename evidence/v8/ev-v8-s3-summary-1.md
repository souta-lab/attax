# V12 Explicit-Generator Shadow Corpus

S1 is BLOCKED because `/tmp/redv7-fixed.ts` is absent; no frozen opponent was recreated.

```json
{
  "seeds": [
    5555,
    9001,
    2,
    23,
    53,
    83
  ],
  "shard": {
    "index": 1,
    "count": 6
  },
  "maxTicks": 12000,
  "configValidation": {
    "fixedSeedCount": 32,
    "uniqueSeedCount": 32,
    "maxTicks": 12000,
    "shard": {
      "index": 1,
      "count": 6,
      "seeds": [
        5555,
        9001,
        2,
        23,
        53,
        83
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
    "controlS3": "0b1f489d",
    "candidateS3": "b0e68845"
  },
  "aggregates": {
    "control": {
      "matches": 6,
      "wins": 3,
      "caps": 1,
      "ticks": 36424,
      "pieces": 2052,
      "winnerCounts": {
        "left": 3,
        "right": 2,
        "draw": 0,
        "cap": 1
      },
      "left": {
        "lines": 565,
        "sent": 257,
        "tsd": 0,
        "tetris": 2,
        "maxPending": 30,
        "maxHeight": 98,
        "holes": 82,
        "executionSourceMismatches": 0,
        "executionExpectedBoardFailures": 0
      },
      "right": {
        "lines": 560,
        "sent": 277,
        "tsd": 0,
        "tetris": 9,
        "maxPending": 24,
        "maxHeight": 92,
        "holes": 70,
        "executionSourceMismatches": 0,
        "executionExpectedBoardFailures": 0
      }
    },
    "candidate": {
      "matches": 6,
      "wins": 1,
      "caps": 1,
      "ticks": 29680,
      "pieces": 1658,
      "winnerCounts": {
        "left": 1,
        "right": 4,
        "draw": 0,
        "cap": 1
      },
      "left": {
        "lines": 438,
        "sent": 206,
        "tsd": 0,
        "tetris": 2,
        "maxPending": 35,
        "maxHeight": 105,
        "holes": 96,
        "executionSourceMismatches": 0,
        "executionExpectedBoardFailures": 0
      },
      "right": {
        "lines": 456,
        "sent": 232,
        "tsd": 0,
        "tetris": 10,
        "maxPending": 23,
        "maxHeight": 79,
        "holes": 54,
        "executionSourceMismatches": 0,
        "executionExpectedBoardFailures": 0
      }
    }
  },
  "perSeed": [
    {
      "seed": 5555,
      "control": {
        "label": "S3",
        "seed": 5555,
        "winner": "right",
        "reason": "KO",
        "ticks": 3304,
        "pieces": 187,
        "left": {
          "lines": 39,
          "sent": 8,
          "tsd": 0,
          "tetris": 0,
          "maxPending": 4,
          "maxHeight": 20,
          "holes": 16,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        },
        "right": {
          "lines": 40,
          "sent": 21,
          "tsd": 0,
          "tetris": 2,
          "maxPending": 2,
          "maxHeight": 10,
          "holes": 2,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        }
      },
      "candidate": {
        "label": "S3",
        "seed": 5555,
        "winner": "right",
        "reason": "KO",
        "ticks": 5464,
        "pieces": 307,
        "left": {
          "lines": 80,
          "sent": 32,
          "tsd": 0,
          "tetris": 0,
          "maxPending": 4,
          "maxHeight": 20,
          "holes": 17,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        },
        "right": {
          "lines": 85,
          "sent": 45,
          "tsd": 0,
          "tetris": 2,
          "maxPending": 3,
          "maxHeight": 10,
          "holes": 7,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        }
      }
    },
    {
      "seed": 9001,
      "control": {
        "label": "S3",
        "seed": 9001,
        "winner": "left",
        "reason": "KO",
        "ticks": 9408,
        "pieces": 529,
        "left": {
          "lines": 151,
          "sent": 75,
          "tsd": 0,
          "tetris": 1,
          "maxPending": 5,
          "maxHeight": 16,
          "holes": 12,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        },
        "right": {
          "lines": 147,
          "sent": 66,
          "tsd": 0,
          "tetris": 2,
          "maxPending": 5,
          "maxHeight": 20,
          "holes": 17,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        }
      },
      "candidate": {
        "label": "S3",
        "seed": 9001,
        "winner": "cap",
        "reason": "max-ticks",
        "ticks": 12000,
        "pieces": 664,
        "left": {
          "lines": 184,
          "sent": 85,
          "tsd": 0,
          "tetris": 1,
          "maxPending": 5,
          "maxHeight": 15,
          "holes": 12,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        },
        "right": {
          "lines": 190,
          "sent": 78,
          "tsd": 0,
          "tetris": 2,
          "maxPending": 4,
          "maxHeight": 17,
          "holes": 14,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        }
      }
    },
    {
      "seed": 2,
      "control": {
        "label": "S3",
        "seed": 2,
        "winner": "left",
        "reason": "KO",
        "ticks": 2496,
        "pieces": 143,
        "left": {
          "lines": 42,
          "sent": 34,
          "tsd": 0,
          "tetris": 0,
          "maxPending": 3,
          "maxHeight": 11,
          "holes": 8,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        },
        "right": {
          "lines": 40,
          "sent": 20,
          "tsd": 0,
          "tetris": 2,
          "maxPending": 6,
          "maxHeight": 19,
          "holes": 17,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        }
      },
      "candidate": {
        "label": "S3",
        "seed": 2,
        "winner": "left",
        "reason": "KO",
        "ticks": 2496,
        "pieces": 143,
        "left": {
          "lines": 42,
          "sent": 34,
          "tsd": 0,
          "tetris": 0,
          "maxPending": 3,
          "maxHeight": 11,
          "holes": 8,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        },
        "right": {
          "lines": 40,
          "sent": 20,
          "tsd": 0,
          "tetris": 2,
          "maxPending": 6,
          "maxHeight": 19,
          "holes": 17,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        }
      }
    },
    {
      "seed": 23,
      "control": {
        "label": "S3",
        "seed": 23,
        "winner": "left",
        "reason": "KO",
        "ticks": 6176,
        "pieces": 341,
        "left": {
          "lines": 94,
          "sent": 52,
          "tsd": 0,
          "tetris": 1,
          "maxPending": 3,
          "maxHeight": 15,
          "holes": 13,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        },
        "right": {
          "lines": 96,
          "sent": 38,
          "tsd": 0,
          "tetris": 0,
          "maxPending": 4,
          "maxHeight": 19,
          "holes": 17,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        }
      },
      "candidate": {
        "label": "S3",
        "seed": 23,
        "winner": "right",
        "reason": "KO",
        "ticks": 4096,
        "pieces": 227,
        "left": {
          "lines": 57,
          "sent": 31,
          "tsd": 0,
          "tetris": 1,
          "maxPending": 7,
          "maxHeight": 19,
          "holes": 17,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        },
        "right": {
          "lines": 65,
          "sent": 37,
          "tsd": 0,
          "tetris": 0,
          "maxPending": 4,
          "maxHeight": 13,
          "holes": 10,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        }
      }
    },
    {
      "seed": 53,
      "control": {
        "label": "S3",
        "seed": 53,
        "winner": "right",
        "reason": "KO",
        "ticks": 3040,
        "pieces": 173,
        "left": {
          "lines": 40,
          "sent": 12,
          "tsd": 0,
          "tetris": 0,
          "maxPending": 11,
          "maxHeight": 20,
          "holes": 19,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        },
        "right": {
          "lines": 43,
          "sent": 26,
          "tsd": 0,
          "tetris": 0,
          "maxPending": 3,
          "maxHeight": 10,
          "holes": 4,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        }
      },
      "candidate": {
        "label": "S3",
        "seed": 53,
        "winner": "right",
        "reason": "KO",
        "ticks": 3040,
        "pieces": 173,
        "left": {
          "lines": 40,
          "sent": 12,
          "tsd": 0,
          "tetris": 0,
          "maxPending": 11,
          "maxHeight": 20,
          "holes": 19,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        },
        "right": {
          "lines": 43,
          "sent": 26,
          "tsd": 0,
          "tetris": 0,
          "maxPending": 3,
          "maxHeight": 10,
          "holes": 4,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        }
      }
    },
    {
      "seed": 83,
      "control": {
        "label": "S3",
        "seed": 83,
        "winner": "cap",
        "reason": "max-ticks",
        "ticks": 12000,
        "pieces": 679,
        "left": {
          "lines": 199,
          "sent": 76,
          "tsd": 0,
          "tetris": 0,
          "maxPending": 4,
          "maxHeight": 16,
          "holes": 14,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        },
        "right": {
          "lines": 194,
          "sent": 106,
          "tsd": 0,
          "tetris": 3,
          "maxPending": 4,
          "maxHeight": 14,
          "holes": 13,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        }
      },
      "candidate": {
        "label": "S3",
        "seed": 83,
        "winner": "right",
        "reason": "KO",
        "ticks": 2584,
        "pieces": 144,
        "left": {
          "lines": 35,
          "sent": 12,
          "tsd": 0,
          "tetris": 0,
          "maxPending": 5,
          "maxHeight": 20,
          "holes": 23,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        },
        "right": {
          "lines": 33,
          "sent": 26,
          "tsd": 0,
          "tetris": 4,
          "maxPending": 3,
          "maxHeight": 10,
          "holes": 2,
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
seed order  5555 9001 2 23 53 83
control     R L L L R C
candidate   R C L R R R
```
