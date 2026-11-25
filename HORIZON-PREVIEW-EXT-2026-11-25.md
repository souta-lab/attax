# HORIZON-PREVIEW-EXT-2026-11-25 — horizon 拡張（preview 5→最大13）の選定と実装

- レーン: attax-horizon-alpha（alpha 式: 実コード＋机上見積のみ。対戦の本測定なし、確認帯は未消費）。
- 任務原典: lanechat #8485（10時間総動員）＋ attax-hoiko-night 最終結論 #8403。

## 1. 残差の原典

- 確認帯2（860001–860030, W7 構成）: 15W–15L の引き分け。確認帯1（W4）も 13–17 で、
  「未使用確認帯で勝ち越し」は未達のまま閉鎖（#8403、秘書回収 #8404）。
- W7 構成 = ROWS=40 ＋ tables-w7-surface.bin（消去スプレッド＋tslot150＋表面形状）。
  出荷構成の実績（820帯 9–21 / 830帯 11–19）から未使用帯で互角まで到達したのが現状。
- 残差の2本柱（#8485 の指定）:
  (1) horizon／セットアップ評価の深さ差 — Hoiko 深さ14 に対し attax は 6手先。
  (2) 攻撃変換率差 — Hoiko 1.27 vs attax 1.07（#8403。「これが次の主戦場」）。

## 2. 選定: (1) horizon 側を採る。preview 拡張を実装する

### 2.1 構造の特定（原典・コード実読）

- attax の 6手先は `tbp/attax-tbp.ts` の
  `preview: queue.slice(1, 1 + BOT_DEFAULTS.preview)`（BOT_DEFAULTS.preview = 5、
  `tools/s2-lab/defaults.ts`）で決まっていた。現在ピース＋preview 5 = 6手が探索の全深さ。
- 決定レコード（`tools/s2-lab/gpu-codec.ts`）は preview 13枠を持ち、
  `seq_len = 1 + preview`、13超は拒否。つまりワイヤ形式は 14手先まで設計済みで、
  截断はアダプタ側の1行だけだった。エンジン・ワイヤの変更は不要。
- ホストが実際に送ったピースしか使わない（queue は start/new_piece 由来のみ）。
  隠し情報の推測はしない。ホストの queue が短ければ slice は短いまま = 安全に縮退する。

### 2.2 (2) 変換率側を今回採らない理由

- 変換率 1.27 vs 1.07 は重みではなく**結果指標**であり、届く実装は tables の
  重み変更（tslot／消去報酬系）になる。それは (a) 並行着地中の attax-w7-land
  （W7 = ROWS40＋tables）の担当面と直接衝突する、(b) 値振りは SPSA 的迷走として
  既存登録で排除済み（NEXT-RESIDUAL-2026-11-24 §3 R2、候補③の教訓）。
- horizon 側は tables・profile に一切触れず、W7 着地との競合が構造的に無い。

## 3. 実装（本枝）

- 枝: `feat/horizon-preview-ext`、土台: main `52ade7ce745067959fd93ae6207b6ceccc6dc22b`
  （KV attax/main-tip と一致を確認してから clone）。
  ※ W7 は attax-w7-land が並行着地中。本枝は W7 着地 tip へ rebase してから
  合体する前提（変更面は tbp/attax-tbp.ts のみで、W7 の変更面と重ならない）。
- 変更: `tbp/attax-tbp.ts` のみ。
  - env `ATTAX_TBP_PREVIEW` を追加（ATTAX_TBP_ROWS と同型の env 解決）。
    0..13 の整数で上書き、未設定・非整数・範囲外は従来既定 5 にフォールバック。
  - **env 未設定時は従来とビット同一**（slice 長 5 のまま）。既定 OFF 相当の分離変種形。
  - ヘッダの Env 一覧と host contract の記述を追随。

## 4. 机上見積 [全て見積・未測定]

- 探索量: beam 幅 96/ply は不変で ply 数が 6→14。
  ノード数の上限比は 14/6 ≒ **2.33倍** [見積]（実際の伸びは枝刈り次第でこれ以下）。
- レイテンシ: 本番 wall 中央値 3.096–3.101 ms/判断は深さ6前提の値
  （KV attax/production、PR #44 着地時）。ply 線形と仮定すれば深さ14で
  **約 7.2 ms/判断** [見積]。TBP 対戦の手番制限に対する可否は合体フェーズの
  実測事項（本レーンでは主張しない）。
- 強さ: W への換算は置かない（置ける原典が無い）。主張できるのは構造の話だけ:
  深さ差 14 vs 6 という**構造的欠陥の除去**であり、W7 で互角（15–15）まで来た
  構成に残る既知の非対称が1つ消える。変換率差（1.27 vs 1.07）への波及は
  セットアップ評価が深くなる分だけ期待方向が正だが、大きさは未測定。

## 5. 合体フェーズへの係属（本レーン未実施）

1. W7 着地 tip への rebase（競合なし見込み: 変更面は tbp/attax-tbp.ts のみ）。
2. 軽量ゲート: `bunx tsc --noEmit` / `bun test` / `bun run lint` / `bun run build`。
3. 実測前の確認2点: (a) ホスト（intetrigence external-arena）が queue を
   14手分実際に送るか — 決定ログ（ATTAX_TBP_LOG）の depth が 14 に届くかで判定。
   届かなければ本機構は no-op であり、その場合はホスト側の queue 供給が先。
   (b) 深さ14 での GPU serve の実レイテンシと seq_len=14 の受理（ゲート180決定形）。
4. 測定は開発帯のみ・登録した1点（PREVIEW=13）の on/off。確認帯は消費しない。
   seed 帯の再ロール禁止は不変。

## 6. 限界

- 本レーンは対戦・leg を一切回していない。数値は全て [見積] か原典再掲。
- 構文確認のみ実施: `bun build tbp/attax-tbp.ts` は成功（12 modules bundled）。
  `bun x tsc --noEmit` は新規 clone に node_modules が無く vite/client 型定義不在で
  起動前に失敗（本変更とは無関係）。フルゲートは §5-2 の合体フェーズ事項。
- ホスト queue 長が 6 のままなら効果はゼロであり、その切り分けは §5-3(a) が担う。
