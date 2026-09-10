# V12 Explicit-Generator Shadow Corpus

S1 is BLOCKED because `/tmp/redv7-fixed.ts` is absent; no frozen opponent was recreated.

```json
{
  "seeds": [
    89,
    97,
    99,
    5,
    31
  ],
  "shard": {
    "index": 5,
    "count": 6
  },
  "maxTicks": 12000,
  "configValidation": {
    "fixedSeedCount": 32,
    "uniqueSeedCount": 32,
    "maxTicks": 12000,
    "shard": {
      "index": 5,
      "count": 6,
      "seeds": [
        89,
        97,
        99,
        5,
        31
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
    "controlS3": "f1eade3d",
    "candidateS3": "5c9b9107"
  },
  "aggregates": {
    "control": {
      "matches": 5,
      "wins": 2,
      "caps": 1,
      "ticks": 43864,
      "pieces": 2452,
      "winnerCounts": {
        "left": 2,
        "right": 2,
        "draw": 0,
        "cap": 1
      },
      "left": {
        "lines": 666,
        "sent": 293,
        "tsd": 0,
        "tetris": 0,
        "maxPending": 21,
        "maxHeight": 87,
        "holes": 72,
        "executionSourceMismatches": 0,
        "executionExpectedBoardFailures": 0
      },
      "right": {
        "lines": 681,
        "sent": 302,
        "tsd": 0,
        "tetris": 6,
        "maxPending": 17,
        "maxHeight": 79,
        "holes": 67,
        "executionSourceMismatches": 0,
        "executionExpectedBoardFailures": 0
      }
    },
    "candidate": {
      "matches": 5,
      "wins": 2,
      "caps": 1,
      "ticks": 55184,
      "pieces": 3046,
      "winnerCounts": {
        "left": 2,
        "right": 2,
        "draw": 0,
        "cap": 1
      },
      "left": {
        "lines": 821,
        "sent": 391,
        "tsd": 0,
        "tetris": 0,
        "maxPending": 20,
        "maxHeight": 87,
        "holes": 71,
        "executionSourceMismatches": 0,
        "executionExpectedBoardFailures": 0
      },
      "right": {
        "lines": 860,
        "sent": 379,
        "tsd": 0,
        "tetris": 13,
        "maxPending": 20,
        "maxHeight": 87,
        "holes": 69,
        "executionSourceMismatches": 0,
        "executionExpectedBoardFailures": 0
      }
    }
  },
  "perSeed": [
    {
      "seed": 89,
      "control": {
        "label": "S3",
        "seed": 89,
        "winner": "left",
        "reason": "KO",
        "ticks": 3792,
        "pieces": 210,
        "left": {
          "lines": 55,
          "sent": 33,
          "tsd": 0,
          "tetris": 0,
          "maxPending": 4,
          "maxHeight": 16,
          "holes": 13,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        },
        "right": {
          "lines": 53,
          "sent": 28,
          "tsd": 0,
          "tetris": 3,
          "maxPending": 3,
          "maxHeight": 20,
          "holes": 20,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        }
      },
      "candidate": {
        "label": "S3",
        "seed": 89,
        "winner": "left",
        "reason": "KO",
        "ticks": 10024,
        "pieces": 545,
        "left": {
          "lines": 145,
          "sent": 73,
          "tsd": 0,
          "tetris": 0,
          "maxPending": 4,
          "maxHeight": 17,
          "holes": 13,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        },
        "right": {
          "lines": 153,
          "sent": 64,
          "tsd": 0,
          "tetris": 2,
          "maxPending": 3,
          "maxHeight": 20,
          "holes": 12,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        }
      }
    },
    {
      "seed": 97,
      "control": {
        "label": "S3",
        "seed": 97,
        "winner": "cap",
        "reason": "max-ticks",
        "ticks": 12000,
        "pieces": 669,
        "left": {
          "lines": 179,
          "sent": 80,
          "tsd": 0,
          "tetris": 0,
          "maxPending": 4,
          "maxHeight": 16,
          "holes": 13,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        },
        "right": {
          "lines": 193,
          "sent": 78,
          "tsd": 0,
          "tetris": 0,
          "maxPending": 3,
          "maxHeight": 14,
          "holes": 11,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        }
      },
      "candidate": {
        "label": "S3",
        "seed": 97,
        "winner": "right",
        "reason": "KO",
        "ticks": 11952,
        "pieces": 658,
        "left": {
          "lines": 184,
          "sent": 91,
          "tsd": 0,
          "tetris": 0,
          "maxPending": 4,
          "maxHeight": 20,
          "holes": 19,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        },
        "right": {
          "lines": 198,
          "sent": 100,
          "tsd": 0,
          "tetris": 3,
          "maxPending": 6,
          "maxHeight": 14,
          "holes": 11,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        }
      }
    },
    {
      "seed": 99,
      "control": {
        "label": "S3",
        "seed": 99,
        "winner": "left",
        "reason": "KO",
        "ticks": 9400,
        "pieces": 537,
        "left": {
          "lines": 148,
          "sent": 66,
          "tsd": 0,
          "tetris": 0,
          "maxPending": 4,
          "maxHeight": 16,
          "holes": 14,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        },
        "right": {
          "lines": 144,
          "sent": 64,
          "tsd": 0,
          "tetris": 2,
          "maxPending": 5,
          "maxHeight": 19,
          "holes": 16,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        }
      },
      "candidate": {
        "label": "S3",
        "seed": 99,
        "winner": "left",
        "reason": "KO",
        "ticks": 10656,
        "pieces": 591,
        "left": {
          "lines": 153,
          "sent": 77,
          "tsd": 0,
          "tetris": 0,
          "maxPending": 4,
          "maxHeight": 14,
          "holes": 11,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        },
        "right": {
          "lines": 156,
          "sent": 54,
          "tsd": 0,
          "tetris": 1,
          "maxPending": 4,
          "maxHeight": 20,
          "holes": 19,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        }
      }
    },
    {
      "seed": 5,
      "control": {
        "label": "S3",
        "seed": 5,
        "winner": "right",
        "reason": "KO",
        "ticks": 8344,
        "pieces": 464,
        "left": {
          "lines": 130,
          "sent": 57,
          "tsd": 0,
          "tetris": 0,
          "maxPending": 5,
          "maxHeight": 19,
          "holes": 15,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        },
        "right": {
          "lines": 135,
          "sent": 66,
          "tsd": 0,
          "tetris": 1,
          "maxPending": 3,
          "maxHeight": 12,
          "holes": 9,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        }
      },
      "candidate": {
        "label": "S3",
        "seed": 5,
        "winner": "right",
        "reason": "KO",
        "ticks": 10552,
        "pieces": 576,
        "left": {
          "lines": 159,
          "sent": 77,
          "tsd": 0,
          "tetris": 0,
          "maxPending": 4,
          "maxHeight": 20,
          "holes": 15,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        },
        "right": {
          "lines": 167,
          "sent": 81,
          "tsd": 0,
          "tetris": 3,
          "maxPending": 4,
          "maxHeight": 17,
          "holes": 15,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        }
      }
    },
    {
      "seed": 31,
      "control": {
        "label": "S3",
        "seed": 31,
        "winner": "right",
        "reason": "KO",
        "ticks": 10328,
        "pieces": 572,
        "left": {
          "lines": 154,
          "sent": 57,
          "tsd": 0,
          "tetris": 0,
          "maxPending": 4,
          "maxHeight": 20,
          "holes": 17,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        },
        "right": {
          "lines": 156,
          "sent": 66,
          "tsd": 0,
          "tetris": 0,
          "maxPending": 3,
          "maxHeight": 14,
          "holes": 11,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        }
      },
      "candidate": {
        "label": "S3",
        "seed": 31,
        "winner": "cap",
        "reason": "max-ticks",
        "ticks": 12000,
        "pieces": 676,
        "left": {
          "lines": 180,
          "sent": 73,
          "tsd": 0,
          "tetris": 0,
          "maxPending": 4,
          "maxHeight": 16,
          "holes": 13,
          "executionSourceMismatches": 0,
          "executionExpectedBoardFailures": 0
        },
        "right": {
          "lines": 186,
          "sent": 80,
          "tsd": 0,
          "tetris": 4,
          "maxPending": 3,
          "maxHeight": 16,
          "holes": 12,
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
seed order  89 97 99 5 31
control     L C L R R
candidate   L R L R C
```
