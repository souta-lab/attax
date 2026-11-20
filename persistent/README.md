# 永続形（persistent form）— 確定スタックの集約

attax の永続形（常駐カーネル形）の、2026-11-20 時点の**確定スタック**を
1 つの自己完結した形にまとめたもの。実験中の候補（ラウンド8〜10 の
変種、案B の計画表化など）は含まない。

確定形は単一ファイル **`pfl_r11.comp`** が体現する（旧確定形 `pfl_r7c1.comp` の上に `r11` を積んだ形）。

## スタック構成

土台はラウンド4の確定形 `pfl_r4tk1.comp`。その上に4段が積み上がる。

| 段 | 生成器 | 差分（1行） |
|---|---|---|
| r6g1 | `gen_r6g1.py` | emitOrderPX の WG0 prefix fan-in 修正: nwg≤64 前提だった fan-in をストライド共有化し、G>64 でも totals が正しく発行されるようにする（nwg≤64 ではビット同一、レジスタ費用ゼロ） |
| int2 | `gen_r6int2.py` | r6g1 に bt1（ヘッダ拡張）＋ ba1（案A移植: 構築項の分岐を clamp＋値マスク化、wall の出所を subgroup ballot 化、seed walk を running counter 化）＋ bh1（hash パッキングの 8 行ブロック転置で gather を削減）を統合 |
| r7c1 | `gen_r7cons.py` | int2 の構築段で、(cOff, ky) が決める項の重複計算を排除: 15 項 → distinct 7–8 値を各1回だけ計算し、ky をコンパイル時定数として畳む（VGPR コストゼロ） |
| **r11** | `gen_r11.py` | S1 を BP (`S1a`, 3バリア BFS) と 100% レーン稼働 BX＋直接 in-wave 評価＋融合 `dedupeA` (`S1b`) に分離／`emitOrderPX` Pass 2 融合 4096-bin `floatBucket12`＋全72WG 並列バケット選択（WG0 `prefixP` 撤廃）／インクリメンタル Top-96＋展開 wave64 bitonic merge（`judgePreCount`/`judgeBuildPX2`/`sortStage`/`gbar X5` 撤廃）／touched-slot `resetScratch`／並列 setup・`candK` キックゲート・`sh<maxh` 空ハッシュ省略・`passB` 生存者スキップ・並列 `matStage`・`surv` 非 coherent 化 |

## 測定状態（正直な記述）

- **r6g1**: フルゲート @72・@84 ともに **PASSED**（全カウンタ 0、fnv
  `aeec061e4f6c4a0c` = 正典一致）。同一窓 ABAB で土台 tk1@48 比
  ≈ −9.2%（混合窓の相対測定）。動作点は **G=72**。
- **int2**: フルゲート @72 **PASSED**（fnv 正典一致）。同一窓 ABAB で
  r6g1@72 比 **−148.8 µs/判断（−3.6%）**。
- **r7c1**: drill @72 合格、同一窓 ABAB で int2 比 **−61 µs/判断
  （−1.5%、両ペア同符号）**。リソースは SGPR 108 / VGPR 120 /
  SpillSGPR 60 / SpillVGPR 0 / LDS 5,120（RADV shaderstats）。
- **r11（確定形）**: RX 6400 (RADV NAVI24) @ **G=72**。
  - リソース（RADV shaderstats）: **SGPR 108 / VGPR 120 / SpillSGPR 46（60→46 減） / SpillVGPR 0 / LDS 4,096 B（5,120→4,096 B 減）**。
  - `pfload drill`: **wave64 (`G=72`) は PASSED**（sabotage 検知＋dec7 全 16 カウンタ 0）。wave32 (`ATTAX_WAVE=32 G=48`) は RDNA2 上の強制実行では PASSED だが、**実 wave32 機（NVIDIA L4）ではパイプライン生成が拒否され、可搬性は不成立**（監査 C、2026-11-20）。wave32 は後回しとし、検証済みの範囲は wave64 のみ。
  - `pfload bench` @72（496 MHz 窓・実測）: **2,090.0–2,109.0 µs/判断**（中央値 **1,974.3–1,982.0 µs/判断**）vs 土台 `pfl_r7c1` **4,137.8 µs/判断**（**約 1.98× 高速化**）。
  - 連続 180 判断実行（`bench2320`、496 MHz 窓・実測）: **G=72 で 1,943.9–1,956.8 µs/判断**（土台 `pfl_r7c1` 3,887.3 µs/判断比 **2.00×**）、**G=84 で 1,856.9–1,877.3 µs/判断**（**2.08×**）。
  - **0.5 ms 主張の撤回（監査 A、2026-11-20）**: かつて 2,320 MHz への ALU 比例換算で 0.42–0.45 ms/手と見積もったが、クロック強制（`power_dpm_force_performance_level=high`、実効 2320 MHz）での実測は bench **2,086.3–2,099.3 µs/判断**・連続 **1,948.6–1,961.1 µs/判断** で、低クロック窓と誤差範囲で変わらなかった。律速は ALU ではなくメモリ/同期側にあり、比例換算の前提は実測で崩れた。**正直な現在地は約 2.0 ms/判断**（監査の自前 bench は 2,054–2,061 µs/判断）。sub-0.5ms は未達。
  - 既定の常駐 WG 数はデスクトップ共在性を優先し **`G=72`**（省略時 72）。`ATTAX_WAVE=64|32` で wave サイズを明示選択可能（省略時はデバイスのネイティブ subgroupSize を自動使用）。`ATTAX_GPU=<substring>` でデバイスを明示選択できる。デバイス選択に黙ったフォールバックはない: 明示指定・RX 6400・離散 GPU のいずれにも当たらなければエラーで終了する（監査 B (h) の修正、2026-11-20）。
  - フルゲート（`pfload_gd gate` @72）: **PASSED**（監査 A、2026-11-20。全カウンタ 0、faults 0、DUMP の fnv `aeec061e4f6c4a0c` = 正典一致、コーパス 180 判断・9,031,554 子）。
  - 監査 B の残件修正（2026-11-20）: CAND 容量ガード（5,461 件を超えたら gbar エラー経路で判断を失敗させる。生成器 `gen_r11.py` の後処理ステップとして実装）と、ホスト側の ply 子数 ≤ 8,192 の入力検証を入れた。

詳細な測定記録は同梱の `PERSISTENT-R6-2026-11-20.md`（r6g1 の
フルゲート詳細は同記録 §6 が引く `PERSISTENT-R6-GCEIL-2026-11-20.md`、
こちらは spike 側に保存され本ブランチには含まない）。

## ファイル一覧

確定形と生成系:

- `pfl_r11.comp` — 確定スタックそのもの（本ブランチ最新）
- `gen_r11.py` — `pfl_r7c1.comp` → `pfl_r11.comp` 生成器
- `pfl_r7c1.comp` — ラウンド7確定形（`gen_r11.py` の入力）
- `gen_r6g1.py` / `gen_r6int2.py` / `gen_r7cons.py` — 生成器（各段）
- `pfl_r4tk1.comp` — 生成チェーンの起点（ラウンド4確定形）
- `pfl_r6g1.comp` / `pfl_r6int2.comp` — 中間段の成果物（次段の入力）
- `pfl_r3n2.comp` / `pfl_r3bt1.comp` / `pfl_r4bt1.comp` /
  `pfl_r6int1.comp` — `gen_r6int2.py` の交差検証・変換素材の入力
  （生成器が sha256 でピン留めして照合する）
- `tables.glsl` / `bx_shapes.glsl` — KX/KY/KN テーブルと形状ヘッダ（スタンドアロンコンパイル用に同梱）

ホストと記録:

- `pfload.c` — 永続形ホスト（drill / bench / dump 用、`./pfload` を作る）
- `pfload_gd.c` — ゲート用ホスト（決定ごとの進捗表示つき、
  `./pfload_gd` を作る。フルゲートはこちらで回す）
- `PERSISTENT-R6-2026-11-20.md` — ラウンド6〜10 の測定記録
  （本ブランチの数値の原典）

## 再生成手順

各生成器は土台を sha256 でピン留めし、不一致なら assert で止まる。
すべて同じディレクトリで実行する。

```sh
python3 gen_r6g1.py pfl_r4tk1.comp   # -> pfl_r6g1.comp      (sha256 efc3f169a0cb…)
python3 gen_r6int2.py                # -> pfl_r6int2.comp    (sha256 f005f4322daa…)
python3 gen_r7cons.py                # -> pfl_r7c1.comp      (sha256 adc2d9a6694f…)
python3 gen_r11.py                   # -> pfl_r11.comp      (sha256 c1d44823b17f…)
```

注意: `gen_r7cons.py` の `TABLES` 定数は原典では spike 側の絶対パス
（`~/workspace/attax-gpu-spike/opus-phase2/bpg/tables.glsl`）を指す。
このディレクトリで再生成する場合は、同梱の `tables.glsl` を指すよう
書き換えること。

## ビルドと実行

```sh
glslangValidator -V --target-env vulkan1.3 -o pfl_r11.spv pfl_r11.comp
gcc -O2 -o pfload    pfload.c    -lvulkan -lm
gcc -O2 -o pfload_gd pfload_gd.c -lvulkan -lm

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
c1d44823b17f76373b7e19ecee89ad37e64f629a79f6c14421e2c5e878bc9230  pfl_r11.comp
d396dfe9f0ecc36056ea03f95118a52a70a7b9f306cec65b0ef1a87dc49316d5  gen_r11.py
7b5c0d3656e6f07d9d7a892e2dde21992a8f37cba82fe9a2614095b21a96e028  bx_shapes.glsl
adc2d9a6694f3e721ec00df5243d17b368fb0174271a7bf897209e55f29b4c2e  pfl_r7c1.comp
f005f4322daaf4dda08cd0bc3ac9ef4237242caca3d72e01ce7d0b1aed1150bf  pfl_r6int2.comp
efc3f169a0cbecf8390c11b586ea226097338af3033dca1996cd659f9ae9a7d5  pfl_r6g1.comp
2f4add4a266948cdadb5cba35e8549cab881df4638f8fcda02fd3b730dba4bcc  pfl_r4tk1.comp
ac32354e7df3ae63f64b7ae25f0bc2e2ea56ae2a50c1c30281f5f672ac2f3b34  pfl_r6int1.comp
3acaf58a685ef5aa9be3803a0576acc40813a585c3d0b7dc33a025ce34879ee8  pfl_r4bt1.comp
b58b8ba969dc3b344873b3c5a7033bac947cd0a297b5bf54269cc731f8275f36  pfload.c
0799a3f40521fa97ab5d3608bf7522ae887df9f21ea5e402fb5b7f9b5f71e260  pfload_gd.c
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
