# V12 Explicit-Generator Shadow Corpus

S1 is BLOCKED because `/tmp/redv7-fixed.ts` is absent; no frozen opponent was recreated.

```json
{
  "seeds": [
    37,
    41,
    43,
    73,
    1234
  ],
  "shard": {
    "index": 3,
    "count": 6
  },
  "maxTicks": 12000,
  "configValidation": {
    "fixedSeedCount": 32,
    "uniqueSeedCount": 32,
    "maxTicks": 12000,
    "shard": {
      "index": 3,
      "count": 6,
      "seeds": [
        37,
        41,
        43,
        73,
        1234
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
    "controlS3": "7356b7fb",
    "candidateS3": "a89069c8"
  },
  "aggregates": {
    "control": {
      "matches": 5,
      "wins": 0,
      "caps": 2,
      "ticks": 46656,
      "pieces": 2618,
      "winnerCounts": {
        "left": 0,
        "right": 3,
        "draw": 0,
        "cap": 2
      },
      "left": {
        "lines": 751,
        "sent": 320,
        "tsd": 0,
        "tetris": 2,
        "maxPending": 24,
        "maxHeight": 93,
        "holes": 86,
        "executionSourceMismatches": 0,
        "executionExpectedBoardFailures": 0
      },
      "right": {
        "lines": 742,
        "sent": 372,
        "tsd": 0,
        "tetris": 15,
        "maxPending": 27,
        "maxHeight": 70,
        "holes": 55,
        "executionSourceMismatches": 0,
        "executionExpectedBoardFailures": 0
      }
    },
    "candidate": {
      "matches": 5,
      "wins": 1,
      "caps": 1,
      "ticks": 39688,
      "pieces": 2212,
      "winnerCounts": {
        "left": 1,
        "right": 3,
        "draw": 0,
        "cap": 1
      },
      "left": {
        "lines": 616,
        "sent": 279,
        "tsd": 0,
        "tetris": 2,
        "maxPending": 22,
        "maxHeight": 92,
        "holes": 77,
        "executionSourceMismatches": 0,
        "executionExpectedBoardFailures": 0
      },
      "right": {
        "lines": 624,
        "sent": 298,
        "tsd": 0,
        "tetris": 11,
        "maxPending": 19,
        "maxHeight": 72,
        "holes": 57,
        "executionSourceMismatches": 0,
        "executionExpectedBoardFailures": 0
      }
    }
  },
  "perSeed": [
    {
      "seed": 37,
      "control": {
        "label": "S3",
        "seed": 37,
        "winner": "right",
        "reason": "KO",
        "ticks": 7448,
        "pieces": 420,
        "left": {
          "lines": 113,
          "sent": 45,
          "tsd": 0,
          "tetris": 1,
          "maxPending": 5,
          "maxHeight": 20,
          "holes": 17,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        },
        "right": {
          "lines": 117,
          "sent": 55,
          "tsd": 0,
          "tetris": 3,
          "maxPending": 4,
          "maxHeight": 13,
          "holes": 10,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        }
      },
      "candidate": {
        "label": "S3",
        "seed": 37,
        "winner": "right",
        "reason": "KO",
        "ticks": 7448,
        "pieces": 420,
        "left": {
          "lines": 113,
          "sent": 45,
          "tsd": 0,
          "tetris": 1,
          "maxPending": 5,
          "maxHeight": 20,
          "holes": 17,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        },
        "right": {
          "lines": 117,
          "sent": 55,
          "tsd": 0,
          "tetris": 3,
          "maxPending": 4,
          "maxHeight": 13,
          "holes": 10,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        }
      }
    },
    {
      "seed": 41,
      "control": {
        "label": "S3",
        "seed": 41,
        "winner": "right",
        "reason": "KO",
        "ticks": 7840,
        "pieces": 441,
        "left": {
          "lines": 131,
          "sent": 54,
          "tsd": 0,
          "tetris": 0,
          "maxPending": 5,
          "maxHeight": 19,
          "holes": 20,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        },
        "right": {
          "lines": 126,
          "sent": 75,
          "tsd": 0,
          "tetris": 5,
          "maxPending": 4,
          "maxHeight": 13,
          "holes": 10,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        }
      },
      "candidate": {
        "label": "S3",
        "seed": 41,
        "winner": "right",
        "reason": "KO",
        "ticks": 4136,
        "pieces": 230,
        "left": {
          "lines": 61,
          "sent": 35,
          "tsd": 0,
          "tetris": 0,
          "maxPending": 4,
          "maxHeight": 20,
          "holes": 17,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        },
        "right": {
          "lines": 66,
          "sent": 38,
          "tsd": 0,
          "tetris": 2,
          "maxPending": 3,
          "maxHeight": 13,
          "holes": 6,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        }
      }
    },
    {
      "seed": 43,
      "control": {
        "label": "S3",
        "seed": 43,
        "winner": "cap",
        "reason": "max-ticks",
        "ticks": 12000,
        "pieces": 677,
        "left": {
          "lines": 188,
          "sent": 79,
          "tsd": 0,
          "tetris": 1,
          "maxPending": 4,
          "maxHeight": 17,
          "holes": 16,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        },
        "right": {
          "lines": 193,
          "sent": 82,
          "tsd": 0,
          "tetris": 1,
          "maxPending": 6,
          "maxHeight": 12,
          "holes": 7,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        }
      },
      "candidate": {
        "label": "S3",
        "seed": 43,
        "winner": "left",
        "reason": "KO",
        "ticks": 8736,
        "pieces": 486,
        "left": {
          "lines": 135,
          "sent": 70,
          "tsd": 0,
          "tetris": 1,
          "maxPending": 4,
          "maxHeight": 15,
          "holes": 12,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        },
        "right": {
          "lines": 135,
          "sent": 51,
          "tsd": 0,
          "tetris": 1,
          "maxPending": 3,
          "maxHeight": 20,
          "holes": 18,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        }
      }
    },
    {
      "seed": 73,
      "control": {
        "label": "S3",
        "seed": 73,
        "winner": "right",
        "reason": "KO",
        "ticks": 7368,
        "pieces": 413,
        "left": {
          "lines": 119,
          "sent": 54,
          "tsd": 0,
          "tetris": 0,
          "maxPending": 5,
          "maxHeight": 20,
          "holes": 18,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        },
        "right": {
          "lines": 116,
          "sent": 68,
          "tsd": 0,
          "tetris": 3,
          "maxPending": 6,
          "maxHeight": 15,
          "holes": 12,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        }
      },
      "candidate": {
        "label": "S3",
        "seed": 73,
        "winner": "right",
        "reason": "KO",
        "ticks": 7368,
        "pieces": 413,
        "left": {
          "lines": 119,
          "sent": 54,
          "tsd": 0,
          "tetris": 0,
          "maxPending": 5,
          "maxHeight": 20,
          "holes": 18,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        },
        "right": {
          "lines": 116,
          "sent": 68,
          "tsd": 0,
          "tetris": 3,
          "maxPending": 6,
          "maxHeight": 15,
          "holes": 12,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        }
      }
    },
    {
      "seed": 1234,
      "control": {
        "label": "S3",
        "seed": 1234,
        "winner": "cap",
        "reason": "max-ticks",
        "ticks": 12000,
        "pieces": 667,
        "left": {
          "lines": 200,
          "sent": 88,
          "tsd": 0,
          "tetris": 0,
          "maxPending": 5,
          "maxHeight": 17,
          "holes": 15,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        },
        "right": {
          "lines": 190,
          "sent": 92,
          "tsd": 0,
          "tetris": 3,
          "maxPending": 7,
          "maxHeight": 17,
          "holes": 16,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        }
      },
      "candidate": {
        "label": "S3",
        "seed": 1234,
        "winner": "cap",
        "reason": "max-ticks",
        "ticks": 12000,
        "pieces": 663,
        "left": {
          "lines": 188,
          "sent": 75,
          "tsd": 0,
          "tetris": 0,
          "maxPending": 4,
          "maxHeight": 17,
          "holes": 13,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        },
        "right": {
          "lines": 190,
          "sent": 86,
          "tsd": 0,
          "tetris": 2,
          "maxPending": 3,
          "maxHeight": 11,
          "holes": 11,
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
seed order  37 41 43 73 1234
control     R R C R C
candidate   R R L R C
```
