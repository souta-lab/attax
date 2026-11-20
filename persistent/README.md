# 永続形（persistent form）— 確定スタックの集約

attax の永続形（常駐カーネル形）の、2026-11-20 時点の**確定スタック**を
1 つの自己完結した形にまとめたもの。実験中の候補（ラウンド8〜10 の
変種、案B の計画表化など）は含まない。

確定形は単一ファイル **`pfl_r7c1.comp`** が体現する。

## スタック構成

土台はラウンド4の確定形 `pfl_r4tk1.comp`。その上に3段が積み上がる。

| 段 | 生成器 | 差分（1行） |
|---|---|---|
| r6g1 | `gen_r6g1.py` | emitOrderPX の WG0 prefix fan-in 修正: nwg≤64 前提だった fan-in をストライド共有化し、G>64 でも totals が正しく発行されるようにする（nwg≤64 ではビット同一、レジスタ費用ゼロ） |
| int2 | `gen_r6int2.py` | r6g1 に bt1（ヘッダ拡張）＋ ba1（案A移植: 構築項の分岐を clamp＋値マスク化、wall の出所を subgroup ballot 化、seed walk を running counter 化）＋ bh1（hash パッキングの 8 行ブロック転置で gather を削減）を統合 |
| r7c1 | `gen_r7cons.py` | int2 の構築段で、(cOff, ky) が決める項の重複計算を排除: 15 項 → distinct 7–8 値を各1回だけ計算し、ky をコンパイル時定数として畳む（VGPR コストゼロ） |

## 測定状態（正直な記述）

- **r6g1**: フルゲート @72・@84 ともに **PASSED**（全カウンタ 0、fnv
  `aeec061e4f6c4a0c` = 正典一致）。同一窓 ABAB で土台 tk1@48 比
  ≈ −9.2%（混合窓の相対測定）。動作点は **G=72**。
- **int2**: フルゲート @72 **PASSED**（fnv 正典一致）。同一窓 ABAB で
  r6g1@72 比 **−148.8 µs/判断（−3.6%）**。
- **r7c1**: drill @72 合格、同一窓 ABAB で int2 比 **−61 µs/判断
  （−1.5%、両ペア同符号）**。リソースは int2 と完全同一
  （SGPR 108 / VGPR 120 / SpillVGPR 0 / LDS 5,120、RADV shaderstats）。
  **フルゲートは未実施**（フルゲートは採用点でまとめて回す方針のため）。
- 永続形の絶対値のクリーン窓確認は未実施で、**絶対値のヘッドラインは
  未確定**。現行の表向き数値は本番形の **3,268 µs/判断** であり、
  永続形が本番形を上回ったとは宣言していない。

詳細な測定記録は同梱の `PERSISTENT-R6-2026-11-20.md`（r6g1 の
フルゲート詳細は同記録 §6 が引く `PERSISTENT-R6-GCEIL-2026-11-20.md`、
こちらは spike 側に保存され本ブランチには含まない）。

## ファイル一覧

確定形と生成系:

- `pfl_r7c1.comp` — 確定スタックそのもの
- `gen_r6g1.py` / `gen_r6int2.py` / `gen_r7cons.py` — 生成器（各段）
- `pfl_r4tk1.comp` — 生成チェーンの起点（ラウンド4確定形）
- `pfl_r6g1.comp` / `pfl_r6int2.comp` — 中間段の成果物（次段の入力）
- `pfl_r3n2.comp` / `pfl_r3bt1.comp` / `pfl_r4bt1.comp` /
  `pfl_r6int1.comp` — `gen_r6int2.py` の交差検証・変換素材の入力
  （生成器が sha256 でピン留めして照合する）
- `tables.glsl` — KX/KY/KN テーブル。`gen_r7cons.py` が読む
  （原典は spike の `opus-phase2/bpg/tables.glsl`、sha256 は
  PC `~/pfload/tables.glsl` とも一致）

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
python3 gen_r6g1.py pfl_r4tk1.comp   # -> pfl_r6g1.comp  (sha256 efc3f169a0cb…)
python3 gen_r6int2.py                # -> pfl_r6int2.comp (sha256 f005f4322daa…)
python3 gen_r7cons.py                # -> pfl_r7c1.comp   (sha256 adc2d9a6694f…)
```

注意: `gen_r7cons.py` の `TABLES` 定数は原典では spike 側の絶対パス
（`~/workspace/attax-gpu-spike/opus-phase2/bpg/tables.glsl`）を指す。
このディレクトリで再生成する場合は、同梱の `tables.glsl` を指すよう
書き換えること。

## ビルドと実行

```sh
glslangValidator -V --target-env vulkan1.3 -o pfl_r7c1.spv pfl_r7c1.comp
gcc -O2 -o pfload    pfload.c    -lvulkan -lm
gcc -O2 -o pfload_gd pfload_gd.c -lvulkan -lm

./pfload    drill pfl_r7c1.spv 72
./pfload    bench pfl_r7c1.spv 72
./pfload_gd gate  pfl_r7c1.spv 72    # フルゲート。ドライバ timeout は 1800 秒
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
adc2d9a6694f3e721ec00df5243d17b368fb0174271a7bf897209e55f29b4c2e  pfl_r7c1.comp
f005f4322daaf4dda08cd0bc3ac9ef4237242caca3d72e01ce7d0b1aed1150bf  pfl_r6int2.comp
efc3f169a0cbecf8390c11b586ea226097338af3033dca1996cd659f9ae9a7d5  pfl_r6g1.comp
2f4add4a266948cdadb5cba35e8549cab881df4638f8fcda02fd3b730dba4bcc  pfl_r4tk1.comp
ac32354e7df3ae63f64b7ae25f0bc2e2ea56ae2a50c1c30281f5f672ac2f3b34  pfl_r6int1.comp
3acaf58a685ef5aa9be3803a0576acc40813a585c3d0b7dc33a025ce34879ee8  pfl_r4bt1.comp
d9541de8e7c9e43a1946de41440f0b74074189626f44e89672d2a1e802af4a60  pfload.c
a3661f5944c1f3a55c6794a064c55a6d673b6381d95dc4b220aa80622db1e57a  pfload_gd.c
a388dff80c3f44ae382432bb79cbb19de6c7fa13cbbe2482e4a0cbd7ad313bc6  tables.glsl
```
