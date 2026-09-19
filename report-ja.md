# pi-qwen-mode-proxy v1.3.2 — omp 上で Qwen モデルの thinking を完全オフにする

**日付:** 2026-09-19
**リポジトリ:** `pi-qwen-mode-proxy`（`~/.omp/plugins/node_modules/pi-qwen-mode-proxy` へのシンボリックリンクでインストール済み）
**サーバー:** llama.cpp @ `http://192.168.0.2:3334`、モデル `Qwen3.8-27B`（GGUF）
**Wire:** `api: openai-responses`（`/v1/responses`）、`~/.omp/agent/models.yml` 内の provider `llama.cpp`

---

## 1. TL;DR（要約）

`thinking: false` のプロファイル（例: `instruct`）は、omp ランタイムが "off" を最低 effort レベルにクランプするにもかかわらず、Qwen モデル上で **thinking トークンを 1 つも生成しなくなった**。extension は **wire 上で**真のオフを強制する: ランタイムが注入する effort 関連フィールドを除去し、`chat_template_kwargs.enable_thinking: false` を設定する。GGUF に焼き込まれた Qwen3 系チャットテンプレートはこの値を `/no_think` にマッピングする。

実サーバーへの live probe で確立した重要な前提: **この GGUF は `enable_thinking: false` を尊重する** — 公式 Qwen 3.8 テンプレートに関する omp のモデルカタログの記述とは対照的である。クランプされた `reasoning: { effort: "low" }` が payload にまだ残っている場合でも、この kwarg が優先される。

---

## 2. 問題

extension の `instruct` プロファイルは `thinking: false` を設定している。意図: instruct モードは thinking を一切しない、ということ。

omp で実際に起きたこと:

1. extension がランタイム API を呼び、thinking を "off" に設定した。
2. omp のランタイムが、`requiresEffort` モデル（Qwen 3.8 が該当）に対して "off" を**最低 effort** にクランプした。
3. セッションは level `low` を報告 — すべての送信 payload が `reasoning: { effort: "low" }` を帯びていた。
4. チャットテンプレートはそれを「低 effort で thinking せよ」と解釈 → thinking が出力された。

つまりプロファイルは "off" を主張し、UI でも off にトグルできたが、モデルは依然として thinking していた。このクランプは omp の**設計上の挙動**である: カタログ上で thinking が必須とされているモデルでは、ランタイムは thinking なし payload の送信を拒否する。なぜなら（カタログによれば）公式 Qwen 3.8 チャットテンプレートは `enable_thinking: false` が渡されると**例外を投げる**からである。

v1.3.0–1.3.1 はその前提を受け入れ、*見かけ上の*クランプされたオフの追跡を実装した: ランタイムは `low` と報告するが、extension は "off" を適用したことを記憶し、プロファイル切替通知がユーザーに「ランタイムが off を low にクランプしました — thinking ブロックを非表示にするには Ctrl+T を押してください」と伝える。正直ではあるが、修正ではない。

## 3. omp が wire 上で thinking をエンコードする方法

同じ llama.cpp サーバーには 2 つの wire 形式があり、thinking のエンコードが異なる:

| | **Responses wire** (`api: openai-responses`) | **Completions wire** (`api: openai-completions`) |
| --- | --- | --- |
| Endpoint | `/v1/responses` | `/v1/chat/completions` |
| thinking を担うフィールド | `reasoning: { effort: "low" \| "medium" \| ... }` | `enable_thinking: true/false`、トップレベルの `reasoning_effort`、および `chat_template_kwargs: { reasoning_effort }` |
| ネイティブな `enable_thinking` 対応 | **なし** — Responses シリアライザーにはそのフィールドがない | あり — 共有シリアライザーの Qwen 分岐が出力する |
| `requiresEffort` モデルでの off | クランプ: `reasoning: { effort: "low" }` | クランプ: `enable_thinking: true` + `reasoning_effort: "low"`（+ kwargs 内の副本） |

クランプは `stream.ts`（`normalizeMandatoryReasoningOptions`）にある: `requiresEffort` モデルで thinking が無効化されると、thinking なしのリクエストをそのまま出さず、最低 effort で置き換える。

帰結: **ランタイム自身のエンコードだけでは、Qwen 3.8 上の "off" は `low` と区別がつかない** — payload はバイト単位で同一である。v1.3.1 の設計がぶつかっていた壁がこれである。

## 4. 調査: live probe

何かを変更する前に、実際のサーバーを probe した。カタログの記述は*公式* Qwen 3.8 テンプレートに関するものであり、テンプレートは GGUF ごとに量子化時に焼き込まれる。コミュニティの量子化版は、代わりに classic な Qwen3 系テンプレートを搭載していることが多い。知る唯一的な方法はサーバーに聞くことだ。

### 4.1 環境

- `http://192.168.0.2:3334` の llama.cpp サーバー
- 提供中のモデルには: `Qwen3.8-27B`、`Qwen3.8-27B-735`、`Qwen3.8-27B-Swift{,-Q5M,-Q5S,-UC}`、`Nail-Qwen3.6-35B-A3B-{Q4,Q5}`、`KAT-Coder-V2.5-Dev`、`Cyber-Tiel-Coder-35B-A3B`
- 全 probe は、最小のプロンプト（"reply with exactly: OK"）と小さなトークン上限付きで、正確なモデル id `Qwen3.8-27B` を使用した
- 注: 初期の probe が `Nail-Qwen3.6-35B-A3B-Q4`（モデルリストで `/qwen/i` に最初にマッチするもの）に当たり、HTTP 500 "failed to load" を返した — そのモデルは読み込まれていなかった。probe は常に、正確な読み込み済みモデル id で実施すること。

### 4.2 Probe マトリクス

| # | Wire | 送信した thinking 関連フィールド | HTTP | 遅延 | 出力 |
| --- | ------ | ------------------------------ | ------ | --------- | -------- |
| A | `/v1/chat/completions` | `chat_template_kwargs: { enable_thinking: false }` | 200 | 約 15.6 秒 | message のみ、**reasoning 文字数 0**、内容 `OK` |
| R1 | `/v1/responses` | `chat_template_kwargs: { enable_thinking: false }` | 200 | 約 15.3 秒 | `output_types: [message]`、**reasoning item なし**、テキスト `OK` |
| R3 | `/v1/responses` | `reasoning: { effort: "low" }` **+** `chat_template_kwargs: { enable_thinking: false }` | 200 | 約 4.7 秒 | `output_types: [message]`、**reasoning item なし**、テキスト `OK` |

### 4.3 発見事項

1. **この GGUF は `enable_thinking: false` を尊重する** — 例外は投げない。classic な Qwen3 系テンプレートはこのフラグを `/no_think` ソフトプロンプトにマッピングし、thinking トークンを 0 にする。
2. **両方の wire 形式で機能する**。`chat_template_kwargs` 経由で、omp がこのサーバーで実際に使用している `/v1/responses` も含む。
3. **kwarg が同時に存在する effort フィールドに優先する**（R3）。payload にクランプされた `reasoning: { effort: "low" }` がまだ残っている場合（omp が実際に生成する状態と一致）でも、テンプレートは thinking を抑制する。R3 が決定的な probe である: これが extension が作成する*正確な wire 状態*だからだ。

### 4.4 なぜカタログの記述が当てはまらないか

omp カタログの Qwen 3.8 に関する `requiresEffort` /「テンプレートが `enable_thinking: false` で例外を投げる」の項目は、**公式 3.8 テンプレート**を記述している。提供中の GGUF は別の（classic な Qwen3 系の）テンプレートを搭載している。両方の記述はそれぞれの対象物に対しては正しい — probe が、ここでどちらが当てはまるかを決定づけた。

**設計への含意:** 失敗モードは、カタログの*逆*になった。もしこの GGUF が公式テンプレートでビルドされたものに取り替えられた場合、instruct モードのリクエストは黙って thinking する代わりにテンプレートエラーで失敗する。この注意は README に記載済み（§9 参照）。

## 5. 解決策: hard-off wire 書き換え

### 5.1 メカニズム

`before_provider_request` フック — ランタイムが payload を構築した後（クランプされた effort フィールドを含む）だが、送信前に発火する — において、**アクティブなプロファイルが `thinking: false` かつ** **リクエストが Qwen モデルを対象としている**とき、extension は payload を書き換える:

1. `payload.reasoning` を削除 — Responses wire の effort 担体。
2. `payload.reasoning_effort` を削除 — Completions wire のトップレベル担体。
3. `payload.enable_thinking` を `false` に反転 — **すでに boolean の場合のみ**（Completions wire。Responses wire にはそのようなフィールドがないため、決して*追加*しない — 不明フィールドのリスクを回避）。
4. `payload.chat_template_kwargs` をマージ: `reasoning_effort` を削除、`enable_thinking: false` を設定、その他のすべての kwarg は保持。

Responses wire 上の結果 wire 状態: `reasoning` フィールドなし、`chat_template_kwargs: { enable_thinking: false }` → テンプレートが `/no_think` を出力 → **thinking トークン 0**。

`applyHardOff` はべき等（再実行しても no-op）であり、payload を書き換えたかどうかを返す。

### 5.2 コード

`extensions/config.ts`:

```ts
/** Qwen models only — `enable_thinking` is Qwen template semantics. */
const QWEN_PATTERN = /qwen/i;

/**
 * Force true thinking-off on an outgoing Qwen payload.
 * ... (full doc comment in source: rationale, probe evidence) ...
 * Mutates `payload`. Returns true when rewritten.
 */
export function applyHardOff(
 payload: Record<string, unknown>,
 model: ModelIdentity | undefined,
): boolean {
 if (!isQwenModel(payload, model)) return false;
 if (payload.reasoning !== undefined) delete payload.reasoning;
 if (payload.reasoning_effort !== undefined) delete payload.reasoning_effort;
 if (typeof payload.enable_thinking === "boolean") payload.enable_thinking = false;
 const prev = (payload.chat_template_kwargs ?? {}) as Record<string, unknown>;
 const kwargs: Record<string, unknown> = { ...prev };
 delete kwargs.reasoning_effort;
 kwargs.enable_thinking = false;
 payload.chat_template_kwargs = kwargs;
 return true;
}
```

`extensions/index.ts`（フック、sampling パラメータ注入の後）:

```ts
// Qwen models: the runtime's clamped "off" would otherwise re-enable
// minimum-effort thinking (see applyHardOff).
if (params.thinking === false) applyHardOff(payload, ctx.model);
return payload;
```

### 5.3 設計判断

| 判断 | 根拠 |
| --- | --- |
| **実装前に probe** | 機能全体が*この* GGUF に焼き込まれたテンプレートに依存する。実サーバーへの probe（R3）は、カタログを読むこと何回分にも相当する。 |
| **kwarg を主たる力として、effort 除去を二重保険として** | R3 が effort 存在下でも kwarg が優先することを証明したので、書き換えはランタイム版本間の payload 形状ドリフトに対して頑健 — かつ effort の除去は意味ノイズを消去する。 |
| **Qwen のみゲート**（payload モデル、またはセッションモデルの id/name/provider に対する `/qwen/i`） | `enable_thinking` は Qwen テンプレートの意味論である。同じサーバーは KAT-Coder や Cyber-Tiel モデルも提供している; それらの payload は触れてはならない。 |
| **プロファイル駆動のスコープ（トグル駆動ではない）** | *アクティブなプロファイル*が `thinking: false` の場合のみ適用。thinking プロファイルでユーザーが実行時に thinking を手動で off にした場合は、ランタイムの通常のクランプ挙動がそのまま効く。 |
| **トップレベルの `enable_thinking` は存在する場合のみ反転** | Responses wire にはそのようなフィールドがない; そこへ不明フィールドを追加するのは不要なリスク。Completions wire にはあるため、そこで正規化する。 |
| **kwargs はマージし、決して置換しない** | ランタイムやユーザーが設定した他の kwarg（例: `thinking_budget`）を保持する。 |
| **設定フラグなし** | 単一ユーザーの個人向け extension で、失敗モードは目に見える（リクエストごとに 500、文書化済み）。フラグは無駄な複雑さになる。 |

### 5.4 ユーザー向け通知

`clampedOffNote(offLevel, hardOff)` に第 2 引数が追加された。Qwen モデルでは、プロファイル切替通知は wire が `enable_thinking: false` を**送信する**（thinking は出力されない）と述べる — Ctrl+T の助言はなくなる。クランプされた**非 Qwen** モデルでは、従来の通知（Ctrl+T / `hideThinkingBlock` の助言つき、oh-my-pi#626）を維持する。

## 6. 変更点（v1.3.1 → v1.3.2）

| ファイル | 変更 |
| --- | --- |
| `extensions/config.ts` | 新規 `QWEN_PATTERN`、`modelCandidates()`（リファクタされた `isTargetModel` と共有）、`isQwenModel()`、`applyHardOff()`; `clampedOffNote` は `(offLevel, hardOff)` を受け取り、hard-off 版メッセージを持つ |
| `extensions/index.ts` | 2 つの新しいヘルパーを import; `applyThinking(profile, ctx)` が `ctx` を受け、通知が Qwen ゲートを確認可能に（5 つの呼び出し箇所すべて更新: プロファイル create/edit/delete/switch、session_start）; `before_provider_request` が `thinking: false` プロファイルで `applyHardOff` を呼び出し; ヘッダー doc コメントを更新 |
| `test-smoke.ts` | `clampedOffNote` のテストを 2 引数に更新; 新規ブロック: Responses wire 書き換え、Completions wire 書き換え、kwargs のマージ/保持、非 Qwen ゲート（payload とセッション識別子）、べき等性 — 新規チェック 15 件 |
| `README.md` | 新セクション "True off for Qwen models"（メカニズム、probe の証拠、GGUF テンプレートの注意）; omp の項目を修正（旧記述「Qwen 3.8 は `enable_thinking:false` を拒否する」を公式テンプレートに限定）; Ctrl+T の段落をクランプされた非 Qwen モデルに限定; "How It Works" が hard-off 書き換えに言及 |
| `package.json` | `1.3.1` → `1.3.2` |

## 7. 検証

| チェック | 結果 |
| --- | --- |
| smoke スイート（`bun test-smoke.ts`） | **106/106 合格**、exit 0（既存 91 + 新規 15） |
| 型チェック（`bunx tsc --noEmit`） | クリーン、出力なし |
| live probe 証拠チェーン | (a) thinking off のとき、omp は Responses wire 上で `reasoning: { effort: "low" }` を送信する（ランタイムのクランプ + Responses シリアライザー）; (b) extension はそれを除去し kwarg を追加する（ユニットテスト）; (c) その正確な wire 状態で thinking は 0 になる（probe R3、live） |
| インストール済みコピー | `~/.omp/plugins/node_modules/pi-qwen-mode-proxy` はワークスペースへのシンボリックリンク（`extensions/index.ts` の mtime が一致: 2026-09-19 15:45:33）; インストール済み `config.ts` に `applyHardOff` があり、インストール済み `index.ts` に配線済み |

**検証後の修正:** レポート作成中に、kwargs 行のインデント修正がその行の識別子に誤字（`keywords` → 正: `kwargs`）を持ち込んでいたことが判明。その場で修正（識別子は隣接する `delete kwargs.reasoning_effort;` 行から導出）し、検証をすべて再実行: 106/106 合格、tsc クリーン。

## 8. v1.3.2 以降のユーザー向け挙動

- **新しい omp セッションを開始**（extension はセッション開始時に再 import される）。
- Qwen モデルで `instruct`（または `thinking: false` のいずれかのプロファイル）に切替 → **thinking ブロックが一切表示されない**; 切替通知は wire が `enable_thinking: false` を送信すると明記する。
- `thinking`/`coding` プロファイル（`thinking: true`）は不変 — thinking は従来どおり機能する。
- Qwen モデルでは `Ctrl+T`（`hideThinkingBlock`、#626）が不要になる; クランプされた非 Qwen モデルへの対処法としては残る。
- pi と omp（dual-runtime）で同様に動作し、両 wire 形式で機能する。

## 9. 注意点と失敗モード

1. **テンプレートの出所が主要な前提である。** 挙動は、量子化時に GGUF に焼き込まれたチャットテンプレートに依存する。`Qwen3.8-27B`（または Qwen 名で提供される他のモデル）が、**公式 Qwen 3.8 テンプレート**（`enable_thinking: false` で例外を投げるもの）を使用したビルドに置き換えられた場合、instruct モードのリクエストはリクエストごとのテンプレートエラー（HTTP 500）で失敗する。優先順の緩和策: classic テンプレートの GGUF を提供、llama.cpp の `--chat-template` を明示して提供、あるいはそのモデルに対してクランプされた（thinking オン）挙動を受け入れる。extension はテンプレート型を事前に検出できない; 失敗は目立つもので、静かではない。
2. **名前ベースのゲート。** Qwen ゲートは `/qwen/i` を、payload のモデル id またはセッションモデルの id/name/provider に対してマッチさせる。id に "qwen" を含む架空の非 Qwen モデルはゲートに引っかかり（リクエストが書き換えられ）、Qwen モデルが非 Qwen 名で提供されている場合は見逃す。llama.cpp の正確なモデル id ではどちらも稀だが、セッションモデルのフォールバックは、Qwen id で `models.yml` に登録されたモデルの后者をカバーする。
3. **Completions wire のトップレベルフィールド。** トップレベル `enable_thinking` の反転は、フィールドがすでに boolean の場合のみ行われ、決して注入されない。将来のランタイム版本が Completions wire で送信をやめた場合でも、kwarg は依然としてオフを強制する（kwarg は両 wire における主たる力）。

## 10. Probe の再現

classic テンプレートの Qwen GGUF をホストする llama.cpp サーバーに対して、決定的な probe（R3）は 1 リクエストで済む:

```http
POST /v1/responses
Content-Type: application/json

{
  "model": "Qwen3.8-27B",
  "input": "Reply with exactly: OK",
  "chat_template_kwargs": { "enable_thinking": false },
  "reasoning": { "effort": "low" }
}
```

期待値: HTTP 200、応答の `output` に `message` item が含まれ、`reasoning` item は**含まれない**。`reasoning` item が現れた場合（またはテンプレートエラーで 500 になった場合）、提供中のテンプレートはこの機能に依存する classic 型と一致しない — §9.1 参照。

## 11. 未完了項目

- ブロッキングはなし。ユーザー側の受入: `instruct` プロファイルで実際の omp セッションを回し、トランスクリプトに thinking が 0 であることを確認（probe + ユニットテストからの期待; 未実行パスはフルランタイムスタックの end-to-end のみ）。
- サーバーのカタログが公式テンプレートの Qwen 3.8 ビルドに切り替わったら、§9.1 を見直す — そこのフォールバックは文書化されているが実装されていない（意図的: probe が現在の GGUF では不要にした）。
