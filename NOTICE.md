# Licensing notice

Attax is licensed under the **GNU Affero General Public License v3.0**
(see `LICENSE`). Copyright (c) 2026 souta-lab.

## Exception: the Hoiko benchmark opponent

The directories `rust/hoiko-core/`, `rust/hoiko-wasm/`, and `src/ai/hoiko/`
contain an independent reimplementation of **Hoiko**, a Tetris AI written by
Ukan and distributed by the author as freeware (no open-source license).
This reimplementation exists only so the published head-to-head benchmark can
be run and verified. It is **not** covered by the AGPL, and no rights to Hoiko
itself are granted by this repository. All rights to Hoiko remain with its
author.

Everything else in this repository — the bot (`src/ai/bot/`), the rules engine
(`src/core/`), the versus controller (`src/versus/`), the TBP adapter (`tbp/`),
the benchmark and UI code — is AGPL-3.0 as stated above.
