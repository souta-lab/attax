# 永続形（persistent form）— 確定スタックの集約

attax の永続形（常駐カーネル形）の、2026-11-20 時点の**確定スタック**を
1 つの自己完結した形にまとめたもの。実験中の候補（ラウンド8〜10 の
変種、案B の計画表化など）は含まない。

確定形は単一ファイル **`pfl_r14_sub800.comp`** が体現する（新チェックポイント `pfl_r13_sub1ms.comp` の上に第 2〜6 回監査の 16 項目を積んだ形）。`-DPROD_MODE=0`（既定・デバッグ出力オン）と `-DPROD_MODE=1`（本番最速・デバッグ出力のみ削除）をコンパイル時フラグ 1 つで切り替え可能。

## スタック構成

土台はラウンド4の確定形 `pfl_r4tk1.comp`。その上に6段が積み上がる。

| 段 | 生成器 | 差分（1行） |
|---|---|---|
| r6g1 | `gen_r6g1.py` | emitOrderPX の WG0 prefix fan-in 修正: nwg≤64 前提だった fan-in をストライド共有化し、G>64 でも totals が正しく発行されるようにする（nwg≤64 ではビット同一、レジスタ費用ゼロ） |
| int2 | `gen_r6int2.py` | r6g1 に bt1（ヘッダ拡張）＋ ba1（案A移植: 構築項の分岐を clamp＋値マスク化、wall の出所を subgroup ballot 化、seed walk を running counter 化）＋ bh1（hash パッキングの 8 行ブロック転置で gather を削減）を統合 |
| r7c1 | `gen_r7cons.py` | int2 の構築段で、(cOff, ky) が決める項の重複計算を排除: 15 項 → distinct 7–8 値を各1回だけ計算し、ky をコンパイル時定数として畳む（VGPR コストゼロ） |
| **r11** | `gen_r11.py` | S1 を BP (`S1a`, 3バリア BFS) と 100% レーン稼働 BX＋直接 in-wave 評価＋融合 `dedupeA` (`S1b`) に分離／`emitOrderPX` Pass 2 融合 4096-bin `floatBucket12`＋全72WG 並列バケット選択（WG0 `prefixP` 撤廃）／インクリメンタル Top-96＋展開 wave64 bitonic merge（`judgePreCount`/`judgeBuildPX2`/`sortStage`/`gbar X5` 撤廃）／touched-slot `resetScratch`／並列 setup・`candK` キックゲート・`sh<maxh` 空ハッシュ省略・`passB` 生存者スキップ・並列 `matStage`・`surv` 非 coherent 化 |
| **r13_sub1ms** | `gen_r13_sub1ms.py` | **Top-1 一致契約・実測サブ 1 ms（新チェックポイント）**: B&B ループ撤廃・1-shot 直接評価＋TOUCHED-slot Top-96／評価演算 FP64→FP32 化（RDNA2 FP64 1/16 律速解除・`tab.t` 初回 FP32 キャッシュ）／1 発 64-bit `atomicMax((vord32<<32)\|~coff)` で `dedupeB` と `gbar(X1)` を完全消滅／列直接 64-bit FNV-1a ハッシュ／`maxBin` 始点降順コアレス 64-bin ブロックスキャン＋2 ワード `bitonic128_2w`／`bpxMainBP` の純ビットボード BFS 化（`RANK/KB/WP/ordSet/RREC/posSetA/PLACE` 撤廃、1 バリア/iter＋直接 twin-dedupe 出力）／除算レス `matStage`／NVIDIA NVVM 互換修正／`-DPROD_MODE=0\|1` 切替対応 |
| **r14_sub800** | `gen_r14_sub800.py` | **`r13` 100% ビット完全一致・VGPR 120→80（144 wave64 スロット解放）・実測 679 µs (@G=96) / 734 µs (@G=72)**: `stageS1b` 32-bit 特徴量＆T-slot 化（`col[0..9]` 20 VGPR 早期解放）／遅延 `classify_spin_g`（96% スキップ）／融合ピース配置＋`O(1)` `row_transitions` 差分／固定レジスタ `pmask` 列更新／1 ワード `SLOTOF`（`REPSGEN` 撤廃）／16 ワード 64B アライン 32-bit `PSTATE`（約 1 億グローバルロード削減）／重複ヒット事前リードチェック／`bpxMainBP` 12 レーン並列コアレス setup＋ゼロバリア直接 `rowAt_g`＋ビットボード `& ~` twin-dedupe（非 twin 57% バリア省略・O ミノ spin ループ省略）／`stageS1` 第 1 波直接チケット割当／`tbin` ブロードキャスト `gbar` 撤廃（3 gbar/ply 化）／2 ブロック展開 MLP スキャン＋Full-128 初回ロード |
| **r15_serve** | `gen_r15_serve.py` | **ライブ常駐 `serve` エンジン化＋S2/Guideline(TBP) デュアルプロファイル対応（実測 Guideline GPU 0.697 ms / 中央値 0.620 ms、S2 GPU 0.766 ms / 中央値 0.715 ms @G=96）**: `pfl_r14_sub800.comp` 上に 108w `DecisionRecord` 直接入力・ライブ ply 間ループ・Guideline/TBP ルール切替（`flags & 2`、180°キック無効・T-spin 限定・Guideline 攻撃表/lock-out 消滅/lift/stock_phi=0）・`stageS0`/`BEAM_A/B`/`gbar(B0a)` 撤廃（`matStage` で全 96 WG 並列 `PSTATE` 直接構築）・`bpxMainBP` 10 ロード `subgroupOr` 化・`stageS1b` 並列 3-chunk prefix sum・`rec.q` コアレス `uvec4` ストアを統合。`pfserve.c` が `vkrunner_s26 serve` 互換プロトコルで TBP (`tbp/attax-tbp.ts`) に直接供給 |

## 測定状態（正直な記述）

- **r6g1**: フルゲート @72・@84 ともに **PASSED**（全カウンタ 0、fnv
  `aeec061e4f6c4a0c` = 正典一致）。同一窓 ABAB で土台 tk1@48 比
  ≈ −9.2%（混合窓の相対測定）。動作点は **G=72**。
- **int2**: フルゲート @72 **PASSED**（fnv 正典一致）。同一窓 ABAB で
  r6g1@72 比 **−148.8 µs/判断（−3.6%）**。
- **r7c1**: drill @72 合格、同一窓 ABAB で int2 比 **−61 µs/判断
  （−1.5%、両ペア同符号）**。リソースは SGPR 108 / VGPR 120 /
  SpillSGPR 60 / SpillVGPR 0 / LDS 5,120（RADV shaderstats）。
- **r11**: RX 6400 (RADV NAVI24) @ **G=72**。
  - リソース（RADV shaderstats）: **SGPR 108 / VGPR 120 / SpillSGPR 46（60→46 減） / SpillVGPR 0 / LDS 4,096 B（5,120→4,096 B 減）**。
  - `pfload drill`: **wave64 (`G=72`) は PASSED**（sabotage 検知＋dec7 全 16 カウンタ 0）。wave32 (`ATTAX_WAVE=32 G=48`) は RDNA2 上の強制実行では PASSED だが、**実 wave32 機（NVIDIA L4）ではパイプライン生成が拒否され、可搬性は不成立**（監査 C、2026-11-20）。wave32 は後回しとし、検証済みの範囲は wave64 のみ。
  - `pfload bench` @72（496 MHz 窓・実測）: **2,090.0–2,109.0 µs/判断**（中央値 **1,974.3–1,982.0 µs/判断**）vs 土台 `pfl_r7c1` **4,137.8 µs/判断**（**約 1.98× 高速化**）。
  - 連続 180 判断実行（`bench2320`、496 MHz 窓・実測）: **G=72 で 1,943.9–1,956.8 µs/判断**（土台 `pfl_r7c1` 3,887.3 µs/判断比 **2.00×**）、**G=84 で 1,856.9–1,877.3 µs/判断**（**2.08×**）。
  - **0.5 ms 主張の撤回（監査 A、2026-11-20）**: かつて 2,320 MHz への ALU 比例換算で 0.42–0.45 ms/手と見積もったが、クロック強制（`power_dpm_force_performance_level=high`、実効 2320 MHz）での実測は bench **2,086.3–2,099.3 µs/判断**・連続 **1,948.6–1,961.1 µs/判断** で、低クロック窓と誤差範囲で変わらなかった。律速は ALU ではなくメモリ/同期側にあり、比例換算の前提は実測で崩れた。**正直な現在地は約 2.0 ms/判断**（監査の自前 bench は 2,054–2,061 µs/判断）。sub-0.5ms は未達。
  - 既定の常駐 WG 数はデスクトップ共在性を優先し **`G=72`**（省略時 72）。`ATTAX_WAVE=64|32` で wave サイズを明示選択可能（省略時はデバイスのネイティブ subgroupSize を自動使用）。`ATTAX_GPU=<substring>` でデバイスを明示選択できる。デバイス選択に黙ったフォールバックはない: 明示指定・RX 6400・離散 GPU のいずれにも当たらなければエラーで終了する（監査 B (h) の修正、2026-11-20）。
  - フルゲート（`pfload_gd gate` @72）: **PASSED**（監査 A、2026-11-20。全カウンタ 0、faults 0、DUMP の fnv `aeec061e4f6c4a0c` = 正典一致、コーパス 180 判断・9,031,554 子）。
  - 監査 B の残件修正（2026-11-20）: CAND 容量ガード（5,461 件を超えたら gbar エラー経路で判断を失敗させる。生成器 `gen_r11.py` の後処理ステップとして実装）と、ホスト側の ply 子数 ≤ 8,192 の入力検証を入れた。
- **r13_sub1ms（最新確定形・Top-1 一致契約・実測サブ 1 ms）**: RX 6400 (RADV NAVI24) @ **G=72**。
  - リソース（RADV shaderstats, `-DPROD_MODE=1`）: **SGPR 108 / VGPR 120 / SpillSGPR 13（r7c1 比 60→13、78% 減） / SpillVGPR 0 / LDS 3,072 B（5,120→3,072 B）**。
  - 検証（`spirv-val --target-env vulkan1.2` 0 エラー＋`pfload dumpsel` 180 決定 / 2,495 ply）:
    - `r11` (FP64 B&B 正本) 比 **Top-1 評価値一致: 2,495/2,495 ply (`100.00%`, 最大差 `3.9e-4`)**、**Top-1 親インスタンス一致: 2,494/2,495 ply (`99.96%`)**。
    - `PROD_MODE=0` vs `PROD_MODE=1` (wave64, `G=72`): **41.2 MB 100% ビット完全一致**。
    - `wave32 (ATTAX_WAVE=32 G=48)` vs `wave64 (G=72)`: **41.2 MB 100% ビット完全一致**（RDNA2 上の強制 wave32 実行での一致。実 wave32 機での正しさは下記のとおり未成立）。
  - `pfload bench` @72（実測）:
    - `-DPROD_MODE=0`: **981.6–988.4 µs/判断**（中央値 **926.8–928.6 µs/判断**）
    - `-DPROD_MODE=1`: **954.9–962.7 µs/判断**（中央値 **890.7–894.7 µs/判断**、`pfl_r7c1` 比 **4.33×**、`pfl_r11` 比 **2.19×**）
  - 連続 180 判断実行（`bench2320`、実測）:
    - `-DPROD_MODE=0`: **925.1–934.3 µs/判断**（中央値 **933.8–941.0 µs/判断**）
    - `-DPROD_MODE=1`: **887.2–896.5 µs/判断**（中央値 **898.6–903.4 µs/判断**、`pfl_r7c1` 比 **4.38×**、`pfl_r11` 比 **2.19×**）
  - NVIDIA NVVM 互換修正: `r11` で NVVM クラッシュ (`NVVM compilation failed: 1`) の原因となっていた `subgroupBroadcast(v, idx)`（非定数/63）および `subgroupShuffleXor(..., 32u|63u)` を `r13_sub1ms` から完全撤廃（`J==32u` を専用 LDS マクロ `BT2_STEP32` に分離し、全 `subgroupShuffleXor` マスクを `1..16` のみに限定）。
  - **実 wave32 機での監査（NVIDIA L4、2026-11-21）**: 実機で `vkCreateComputePipelines` を通過し 180 判断を完走した。**NVVM-safe はコンパイルの意味では実証済み**。実 wave32 での `pfload drill` verify は dec7 から大量不一致（hash/U/feat/q1 各 ≈55,302 件）となり **FAIL**。ただしこの drill verify は B&B 時代の記録意味論に校正された物差しで、r13 では RX 6400 の wave64 でも設計どおり通らない（下記）。選択手粒度では、L4 実機で生成した `dumpsel` が RX 6400 (wave64) の `dumpsel` とバイト一致した。**wave32 対応は後回し（未対応）**とし、検証済みの範囲は wave64 のみ。
  - `pfload drill` / `pfload_gd gate` の記録レベル verify は r13 には適用できない: verify は旧ハッシュの再計算・FP64 の U 照合・B&B の生存/評価集合を前提にしており、r13 の内部変更（列直接 FNV-1a ハッシュ・FP32 評価・全子評価）と衝突する。r13 の検証契約は `dumpsel` による選択手粒度の照合である。統合後ホストでの再演（2026-11-21）でも上記の数値を再現した（親インスタンス一致 2,494/2,495、値の最大差 3.9e-4、PROD_MODE=0/1 はバイト一致）。
- **r14_sub800（最新確定形・第 2〜6 回監査統合・`r13` 100% ビット完全一致・実測 679 µs/判断）**: RX 6400 (RADV NAVI24)。
  - リソース（RADV shaderstats, `-DPROD_MODE=1`）: **SGPR 108 / VGPR 80（120→80、33% 減・Pre-Sched VGPRs 75） / SpillSGPR 13（v_writelane/v_readlane 1VGPR レーン退避、VRAM スピル 0） / SpillVGPR 0 / LDS 2,944 B**。
  - **ハードウェア occupancy の段階跳躍**: VGPR 120→80 により RDNA2 1 SIMD あたり **4 waves → 6 waves**、RX 6400 全体の同時常駐 wave64 スロット上限が **96 → 144 スロット（+50%）** に拡大。これにより `G=72` で **72 スロット（50%）空き**、`G=96` でも **48 スロット（33%）空き** を維持したまま駆動可能。
  - 検証（`spirv-val --target-env vulkan1.2` 0 エラー＋`pfload dumpsel` 全 180 決定 / 2,495 ply / `41,241,320` B `cmp`）:
    - 新チェックポイント `pfl_r13_sub1ms` 比: **`PROD_MODE=1` (`G=72`, `G=96`)・`PROD_MODE=0` (`G=72`)・RDNA2 wave32 (`ATTAX_WAVE=32 G=48`) すべて 41.2 MB 100% バイト完全一致（`cmp` exit 0）**。
  - `pfload bench`（実測）:
    - **`G=72`**（72 スロット空き）: **`-DPROD_MODE=1` 789.7 µs/判断**（中央値 **738.3 µs/判断**）、`-DPROD_MODE=0` **827.8 µs/判断**（中央値 **778.1 µs/判断**）
    - **`G=96`**（48 スロット空き）: **`-DPROD_MODE=1` 732.1 µs/判断**（中央値 **680.1 µs/判断**）
  - 連続 180 判断実行（`bench2320`、実測）:
    - **`G=72`**（72 スロット空き）: **`-DPROD_MODE=1` 734.5 µs/判断**（中央値 **740.6 µs/判断**、wall **753.7 µs/判断**、`pfl_r7c1` 比 **5.29×**、`pfl_r13_sub1ms` 比 **−152.7 µs / −17.2%**）、`-DPROD_MODE=0` **777.9 µs/判断**（中央値 **785.0 µs/判断**）
    - **`G=96`**（48 スロット空き）: **`-DPROD_MODE=1` 679.2 µs/判断**（中央値 **686.2 µs/判断**、wall **698.7 µs/判断**、`pfl_r7c1` 比 **5.72×**、`pfl_r13_sub1ms` 比 **−208.0 µs / −23.4%**）
- **r15_serve（最新ライブ `serve` 確定形・S2/Guideline 両対応・TBP 既定バックエンド）**: RX 6400 (RADV NAVI24) @ **G=96**。
  - リソース（RADV shaderstats）: **SGPR 108 / VGPR 80 / SpillSGPR 5 / SpillVGPR 0 / LDS 3,072 B / Scratch 0**（144 wave64 スロット常駐枠）。
  - 180 判断コーパス `vkrunner_s26` 正本比 一致検証（`pfserve run` vs `vkrunner_s26 run`）:
    - **S2**: **180/180 (`100.00%`) セル完全一致**、評価値差 `< 1e-2` **180/180**（最大差 `0.000370`）、ノード数一致 **176/180**。
    - **Guideline (TBP)**: **179/180 (`99.44%`) セル完全一致**、評価値差 `< 1e-2` **180/180**（最大差 `0.000761`）、ノード数一致 **178/180**（唯一の差分 dec 29 は評価値差 `0.000104` の同値タイ）。
  - `pfserve bench`（180 判断 × 3 reps、0 non-ok）:
    - **Guideline (TBP)**: **GPU span 平均 0.697 ms（中央値 0.620 ms、最小 0.551 ms）**、Wall 平均 **0.958 ms（中央値 0.708 ms）**。
    - **S2**: **GPU span 平均 0.766 ms（中央値 0.715 ms、最小 0.168 ms）**、Wall 平均 **1.022 ms（中央値 0.813 ms）**。

詳細な測定記録は同梱の `PERSISTENT-R6-2026-11-20.md`（r6g1 の
フルゲート詳細は同記録 §6 が引く `PERSISTENT-R6-GCEIL-2026-11-20.md`、
こちらは spike 側に保存され本ブランチには含まない）。

## ファイル一覧

確定形と生成系:

- `pfl_r15_serve.comp` — ライブ `serve` 確定形（S2/Guideline 両対応、`VGPRs: 80`、コンパイル済み SPIR-V は `../gpu/shaders/pfl_r15_serve.spv`）
- `gen_r15_serve.py` — `pfl_r14_sub800.comp` → `pfl_r15_serve.comp` 生成器
- `pfserve.c` — ライブ常駐 `serve`/`bench`/`run` ホスト（`bash gpu/build.sh` で `persistent/pfserve` をビルド、`tbp/attax-tbp.ts` の既定バックエンド）
- `pfl_r14_sub800.comp` — 確定スタックそのもの（最新・実測 679 µs @G=96 / 734 µs @G=72、`VGPRs: 80`、`pfl_r13_sub1ms.comp` と 100% ビット完全一致、`-DPROD_MODE=0|1` 切替対応）
- `gen_r14_sub800.py` — `pfl_r13_sub1ms.comp` → `pfl_r14_sub800.comp` 生成器
- `pfl_r13_sub1ms.comp` — チェックポイント確定形（実測 887 µs、`gen_r14_sub800.py` の入力および `dumpsel` 完全一致基準）
- `gen_r13_sub1ms.py` — `r11` → `pfl_r13_sub1ms.comp` 生成器。入力は監査済み r11 の内容（sha256 `c1c1144a774e…`）をファイル名 `pfl_r11_sub500.comp` でピン留めしている（下記の再生成手順の注意を参照）
- `pfl_r11.comp` — r11 確定形（監査 B 修正適用版。r13 の系譜上の土台で、`dumpsel` 照合の基準）
- `gen_r11.py` — `pfl_r7c1.comp` → `pfl_r11.comp` 生成器（監査 B 修正の後処理を含む）
- `pfl_r7c1.comp` — ラウンド7確定形（`gen_r11.py` の入力）
- `gen_r6g1.py` / `gen_r6int2.py` / `gen_r7cons.py` — 生成器（各段）
- `pfl_r4tk1.comp` — 生成チェーンの起点（ラウンド4確定形）
- `pfl_r6g1.comp` / `pfl_r6int2.comp` — 中間段の成果物（次段の入力）
- `pfl_r3n2.comp` / `pfl_r3bt1.comp` / `pfl_r4bt1.comp` /
  `pfl_r6int1.comp` — `gen_r6int2.py` の交差検証・変換素材の入力
  （生成器が sha256 でピン留めして照合する）
- `tables.glsl` / `bx_shapes.glsl` — KX/KY/KN テーブルと形状ヘッダ（スタンドアロンコンパイル用に同梱）

ホストと記録:

- `pfload.c` — 永続形ホスト（drill / bench / dump / dumpsel 用、`./pfload` を作る）
- `pfload_gd.c` — ゲート用ホスト（決定ごとの進捗表示つき、
  `./pfload_gd` を作る。フルゲートはこちらで回す）
- `PERSISTENT-R6-2026-11-20.md` — ラウンド6〜10 の測定記録
  （本ブランチの数値の原典）

## 再生成手順

各生成器は土台を sha256 でピン留めし、不一致なら assert で止まる。
すべて同じディレクトリで実行する。

```sh
python3 gen_r6g1.py pfl_r4tk1.comp   # -> pfl_r6g1.comp       (sha256 efc3f169a0cb…)
python3 gen_r6int2.py                # -> pfl_r6int2.comp     (sha256 f005f4322daa…)
python3 gen_r7cons.py                # -> pfl_r7c1.comp       (sha256 adc2d9a6694f…)
python3 gen_r11.py                   # -> pfl_r11.comp        (sha256 c1d44823b17f…)
python3 gen_r13_sub1ms.py            # -> pfl_r13_sub1ms.comp (sha256 090f1044bf19…)
python3 gen_r14_sub800.py            # -> pfl_r14_sub800.comp (sha256 c221180bf44c…)
python3 gen_r15_serve.py             # -> pfl_r15_serve.comp  (sha256 99a7f98da0ae…; W8 near-T-slot step 6b, 2026-11-25)
```

注意: `gen_r13_sub1ms.py` の入力は監査済み r11 の内容（sha256
`c1c1144a774e…`、監査 B 修正の適用前）で、ファイル名 `pfl_r11_sub500.comp`
としてピン留めされている。本ツリーの `pfl_r11.comp` は監査 B 修正の
適用版（sha256 `c1d44823b17f…`）のため、そのままでは再生成できない。
r13 を再生成する場合は、ピン留めされた入力を `pfl_r11_sub500.comp` の
名前で生成器と同じディレクトリに置いて実行すること。

注意: `gen_r7cons.py` の `TABLES` 定数は原典では spike 側の絶対パス
（`~/workspace/attax-gpu-spike/opus-phase2/bpg/tables.glsl`）を指す。
このディレクトリで再生成する場合は、同梱の `tables.glsl` を指すよう
書き換えること。

## ビルドと実行

```sh
# デバッグ／検証モード（既定: -DPROD_MODE=0、plc/status/64B rec/16w OHEAD を全出力）
glslangValidator -V --target-env vulkan1.2 -DPROD_MODE=0 -o pfl_r14_dbg.spv  pfl_r14_sub800.comp
# 本番最速モード（-DPROD_MODE=1、デバッグ出力のみ削除・選択結果は 100% ビット同一）
glslangValidator -V --target-env vulkan1.2 -DPROD_MODE=1 -o pfl_r14_prod.spv pfl_r14_sub800.comp
glslangValidator -V --target-env vulkan1.2 -DPROD_MODE=1 -o pfl_r13_prod.spv pfl_r13_sub1ms.comp
glslangValidator -V --target-env vulkan1.3 -o pfl_r11.spv pfl_r11.comp

gcc -O2 -o pfload    pfload.c    -lvulkan -lm
gcc -O2 -o pfload_gd pfload_gd.c -lvulkan -lm

# ベンチマーク（wave64 既定 G=72 または高スループット G=96）
./pfload bench pfl_r14_prod.spv 72
./pfload bench pfl_r14_prod.spv 96

# r13 チェックポイント vs r14 (PROD_MODE=0 vs 1) の完全一致検証（全 180 決定 / 2,495 ply / 41.2 MB）
./pfload dumpsel pfl_r13_prod.spv 72 /tmp/sel_r13_prod.bin
./pfload dumpsel pfl_r14_dbg.spv  72 /tmp/sel_r14_dbg.bin
./pfload dumpsel pfl_r14_prod.spv 72 /tmp/sel_r14_prod.bin
cmp /tmp/sel_r13_prod.bin /tmp/sel_r14_prod.bin && echo "r14 == r13 EXACT BIT-IDENTICAL"
cmp /tmp/sel_r14_dbg.bin  /tmp/sel_r14_prod.bin && echo "PROD_MODE 0 == 1 EXACT BIT-IDENTICAL"
# wave32 は RDNA2 上の強制実行でのみ wave64 とビット一致する
# （実 wave32 機では未対応 — 「測定状態」の L4 監査の項を参照）
ATTAX_WAVE=32 ./pfload dumpsel pfl_r14_prod.spv 48 /tmp/sel_r14_w32.bin
cmp /tmp/sel_r13_prod.bin /tmp/sel_r14_w32.bin && echo "WAVE32 == WAVE64 BIT-IDENTICAL"

./pfload    drill pfl_r11.spv 72
./pfload    bench pfl_r11.spv 72
./pfload_gd gate  pfl_r11.spv 72    # フルゲート。ドライバ timeout は 1800 秒
```

- `G` は常駐ワークグループ数。動作点は **72**。**G は 12 の倍数で
  あること**（常駐 WG が 12 グループに分割される設計のため、
  `pfload.c` は `G / 12` を制御ブロックへ渡す）。
- fan-in 修正（r6g1）は G>60 の tk1 系譜には必須。G≤64 では従来と
  ビット同一。
- pfload のデータパスは環境変数 `BXDUMP` / `BPDUMP` / `TABLES` /
  `URES` で与える（既定値は PC 上のパス）。ゲート用コーパス
  （180 判断分）は本ブランチには含まれない。
- ゲートの生死を pfload の無出力で判断してはならない。
  `pfload_gd` の決定ごとの進捗で見ること。

## sha256

```
99a7f98da0ae5a61db58b69982afde29dc7c14ece1803ca2c20a95428f1f5327  pfl_r15_serve.comp
679a42450e8a49af36504b865e33b0621e0251aa7eb923fb3fb868a49f73f6f4  gen_r15_serve.py
8dba539faf12327cf591f45dfaae754ca510b437eabb852f5cdce66dbdded7da  pfserve.c
c221180bf44ca2d6745431200ce2c60db29d5207ca13cf1e7fdc149c829074db  pfl_r14_sub800.comp
eeedc77d86ac4a2df30e21d5c7d29b901a8b4d7dcceefb02eca31564e8110a4b  gen_r14_sub800.py
090f1044bf19c4aed9666dd773149260da387b5f0425ec34fcdb55c156378456  pfl_r13_sub1ms.comp
dd412511926ce74fde9d310e6c82eba2b083eb922c1e6b8a4c78350e4d578f17  gen_r13_sub1ms.py
c1d44823b17f76373b7e19ecee89ad37e64f629a79f6c14421e2c5e878bc9230  pfl_r11.comp
d396dfe9f0ecc36056ea03f95118a52a70a7b9f306cec65b0ef1a87dc49316d5  gen_r11.py
7b5c0d3656e6f07d9d7a892e2dde21992a8f37cba82fe9a2614095b21a96e028  bx_shapes.glsl
adc2d9a6694f3e721ec00df5243d17b368fb0174271a7bf897209e55f29b4c2e  pfl_r7c1.comp
f005f4322daaf4dda08cd0bc3ac9ef4237242caca3d72e01ce7d0b1aed1150bf  pfl_r6int2.comp
efc3f169a0cbecf8390c11b586ea226097338af3033dca1996cd659f9ae9a7d5  pfl_r6g1.comp
2f4add4a266948cdadb5cba35e8549cab881df4638f8fcda02fd3b730dba4bcc  pfl_r4tk1.comp
ac32354e7df3ae63f64b7ae25f0bc2e2ea56ae2a50c1c30281f5f672ac2f3b34  pfl_r6int1.comp
3acaf58a685ef5aa9be3803a0576acc40813a585c3d0b7dc33a025ce34879ee8  pfl_r4bt1.comp
7ee756b9d84be026d1d58dfaf69684df7d4eb45b445194c640451c0022810a22  pfload.c
d2ba59c918213f16aaba7ac9c8582592478e091bff0f054ab7d253f5e42aa80c  pfload_gd.c
a388dff80c3f44ae382432bb79cbb19de6c7fa13cbbe2482e4a0cbd7ad313bc6  tables.glsl
```

## ラウンド10 採用候補（2026-11-20 追加）

土台 `pfl_r7c1`（G=72）からの独立変種。3つとも drill PASSED（ビット同一）で、リソースは土台と同一（SGPR 108 / VGPR 120 / spill 0）。数値はすべて混合クロック窓での同窓 ABAB 相対値であり、絶対値の確定はしていない。3変種を合成したファイルはまだ作っていない（合成とその検証は未実施）。main へは未着地。

- `pfl_r10efan.comp` — emitOrderPX の fan-in を2サブグループスキャンに置換。ABAB −321.1/−534.1 µs。勝ち幅の大きい側の機構が未解明なため、保守側の主張は約 −300 µs（約 −7.4%）。生成は `gen_r10b.py`。
- `pfl_r10fr.comp` — prefixP compaction の走査融合と蝶型全リダクション。ABAB −96.5 µs（−2.5%、両ブロック同符号で安定）。生成は `gen_r10.py`。
- `pfl_r10snp.comp` — sortStage のペイロードなしネットワーク（fit ≡ plyCB(ply) + ord の恒等式を利用）。ABAB −44.9/−19.7 µs、平均 −32.3 µs。生成は `gen_r10c.py`。

sha256:
- `pfl_r10efan.comp` 015ccd93c5d072c4c22aade41da9c73c412b7b91e8a16522853705ffe06f7b6a
- `pfl_r10fr.comp` 7a3675c52330a0add92b4770b39d3df9d941bb6f62e2e4f78c92d123a0e3c2e2
- `pfl_r10snp.comp` 4918024fcac984fab597e7a50b32eee9da537846703b0293131322a48d0f3685
