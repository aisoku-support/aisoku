# 無料AI共有チャンクルーター V1：接続・運用契約

仕様の正は `CURRENT_SPEC` 14.3 / 14.5。本書はバックエンド実装の接続契約。
Flutter実装、本番migration、Secrets設定、本番deployは今回実施していない。

## Flutterとの接続

既存 `generate-ai-replies` にPublishable KeyでPOSTする。

```json
{"mode":"sharedInitial","topicId":"対象TopicのUUID"}
```

タイトル・Facts・代表URLはDBから取得する。Provider、モデル、プロンプト、ユーザー投稿をクライアントから受け付けない。
正常Topicは最新の `thread_title / subject / event / facts`、singletonは代表記事のtitle / descriptionを使用する。
初回の各候補は既存プロンプトの独立10レス（`independent`、`replyTo:null`）として生成する。

| HTTP | status | Flutterの処理 |
| --- | --- | --- |
| 200 | ready | `chunkIndex:1`。既存 `ReplyCacheService.loadChunk` でチャンク1を取得・表示する |
| 202 | running | ジョブ受付済み、または別リクエストが実行中。本文はまだ返さない |
| 202 | deferred | 利用可能候補なし等。`retryAfterSeconds:60` より前の再要求を避ける |
| 200 | exhausted | 全5候補が送信済み。自動再送しない。31Bが後から保存すれば次の要求はreadyになる |
| 404 | not_found | 公開条件を満たすTopicが存在しない。通信失敗と区別する |
| 400/401 | error | 入力/Publishable Keyエラー |
| 502/503 | error | DB等の一時障害、またはbackground実行環境なし。不存在に確定しない |

## 段階的な有効化

`AI_SHARED_ROUTER_ROLLOUT` はサーバー側JSON設定で、欠落・不正JSON・不正な項目がある場合はルーターを無効にする。`{"enabled":false,"allowedTopicIds":["<Topic UUID>"]}` は最大10件のUUID完全一致allowlistとして働き、テストTopicまたは小規模な一般Topic pilotに利用できる。一般Topicを登録する場合も公開条件を満たすTopicだけを選び、まずは少数に限定する。未許可Topicへの `sharedInitial` はHTTP 202の `deferred` を返し、ジョブ作成・`waitUntil`・Provider通信を開始しない。`{"enabled":true}` は全体有効化であり、明示的な段階公開判断なしに使わない。即時停止は `allowedTopicIds` と `singleModel` を外した `{"enabled":false}` を設定する。既存の `sharedAi` / `userReply` / `specificPersonReply` API経路はこの設定の影響を受けない。

1モデルだけの低流量canaryには `singleModel` に固定モデル名を追加できる。これは `enabled:false` かつ許可Topicが一致する1件だけの場合に限り有効で、そのTopicでは指定モデル1件だけを候補にしてfallbackしない。例: `{"enabled":false,"allowedTopicIds":["<Topic UUID>"],"singleModel":"groq-120b"}`。全モデルの通常fallback動作へ進める場合は `singleModel` を外し、allowlistは小さく保つ。異常時はallowlistを含めてrolloutを無効設定へ戻す。

`running` の間は1〜2秒程度の間隔で同じPOSTを行い、`ready` をチャンク1完成通知として扱う。
これは状態確認と期限切れ復旧のAPIであり、presenceや生成継続条件ではない。
画面離脱後も送信済み処理は継続する。ポーリング停止でジョブは停止しない。
表示待ちは既存45秒timeout等で打ち切ってよい。後のアクセスで再確認できる。
多人数のポーリングはEdge invocationに計上されるため、同一端末の要求をまとめ、待機時間に上限を設ける。

Flutter側の必要変更：

- Topicのチャンク1 MISS時だけ `sharedInitial` を呼ぶ。
- `ready` の後は保存済みチャンクを読む。本文配列として扱ったり、Flutterから再保存しない。
- `independent` を含め、番号・名前・ID・replyToの表示変換は既存のキャッシュ読取経路を使用する。
- チャンク2以降は既存のスクロール契機で読み、MISS時の既存生成処理を維持する。
- 旧 `sharedAi` APIは後続生成用に維持した。初回の旧APIへの自動フォールバックは実装しない。
- `userReply` / `specificPersonReply`、保存記事の不存在判定は既存契約を維持する。

## ジョブと保存

`shared_ai_jobs` はTopic単位、`shared_ai_attempts` は `(topic_id,model)` が一意。
ownerと135秒leaseをDBで確認する。送信前に試行を記録し、期限切れ後は送信済みをunknownへ移す。
復旧時は送信済みモデルを除外する。送信直前の環境停止で実送信しなかった場合も保守的に再送しない。
利用枠不足でスキップしたモデルは送信済み扱いにせず、終了後60秒を空けたアクセスで再評価する。

最初の利用可能2候補はProvider処理を待たず開始する。以降は全実行中モデルの開始から3秒、または全失敗で次候補へ進む。
起動処理は20秒を目安に打ち切り、各Providerには90秒timeoutを設定する。DBのleaseとEdge Freeの150秒上限に余裕を残す。
チャンク1保存後は追加しない。起動済みPromiseは `EdgeRuntime.waitUntil` で保存終了まで待つ。
`waitUntil` に完了保証はなく、環境停止で未保存結果が失われることはある。

共通 `append_shared_ai_chunk` はarticle行ロック下でmax+1を割り当てる。
`generation_attempt` の一意制約で再保存を冪等化する。
既存Flutter INSERTもarticleロックを取得するtriggerで直列化する（既存の固定番号重複は従来どおりunique conflict）。
31Bの `save_topic_pregen_chunk` は従来のgeneration確認を行い、共通appendへ委譲する。
31Bのretry/cooldown/最新Topic切替は変更しない。31B retryからRedisへアクセスしない。
管理テーブル・RPCはservice_role限定で、公開RLSポリシーを追加しない。

## 共通quota設定

`AI_QUOTA_CONFIG` はサーバー側JSON。未設定時は新ルーターの全モデルを無効にし、既存Topic Processingは従来どおり動作する。
設定後はFactsとGroq Stage 1も共通リミッターを通るため、以下の全利用モデルのquotaを確認してから同時に設定する。
不正JSON、欠損quota、Redis失敗時は設定済み経路をfail closedにする。

エントリー名：`groq-120b`、`google-gemma`、`cloudflare-gemma`、`gemini-3.1`、`openrouter-nemotron`。
既存Stage 1用：`qwen/qwen3.8-27b`、`openai/gpt-oss-20b`。

Groq・Googleは既存形式 `{ "free": true, "quotas": [...] }` を維持する。Cloudflare・OpenRouterは `provider` による専用検証を使い、公開されていないTPM/RPDを要求しない。
`free:true` は対象アカウント/プロジェクトが無料枠で利用でき、有料超過を起こさないことを運用側で確認した場合だけ指定する。
固定モデル以外や有料モデルへのフォールバックはない。
quotaオブジェクトのフィールド：

| フィールド | 意味 |
| --- | --- |
| scope | 秘密でないquota共有グループ名。APIキーやTopic IDを含めない |
| rpm / tpm / rpd | Groq・Googleで確認済み上限以下に設定。必須 |
| tpd / itpm / otpm | 実際に適用される場合の追加上限 |
| day | `PT` / `UTC` / `rolling`（保守的な直近24時間） |
| inputOnly | trueならTPMを入力のみで予約。GoogleのTPMに対応 |
| factsReserveRpm / factsReserveTpm | Googleコメントから残す余裕。省略時1 request / 4096 tokens。実際のFacts入力上限に合わせて設定する |
| neuronsPerDay | Cloudflareの全Workers AI共通枠。Gemma 4 26Bでは公式換算係数も必須 |

Cloudflare Gemma 4 26Bは次の形式を使う。RPMとNeuronsを同一の原子的予約で確保し、Neuronsの日次カウンターは全Cloudflareモデル間で共有する。26Bの換算係数は入力9,091・出力27,273 Neurons / 1M tokensに固定され、異なる値や係数なしではモデルを有効化しない。実利用量を信頼できる応答usageから精算する実装はないため、予約Neuronsは返却しない。

```json
{
  "cloudflare-gemma": {
    "free": true,
    "provider": "cloudflare",
    "quotas": [{
      "scope": "cloudflare-workers-ai-neurons",
      "rpm": 300,
      "neuronsPerDay": 10000,
      "inputNeuronsPerMillionTokens": 9091,
      "outputNeuronsPerMillionTokens": 27273,
      "day": "UTC"
    }]
  }
}
```

OpenRouterの無料モデルは、無料モデル全体で同じscopeを指定する。RPMは20。`dailyTier`を省略または`base`にした場合は50 RPD、累計購入額10 USD以上を運用者が確認した場合に限り、明示的な`credit_qualified`で1,000 RPDを適用する。購入状況は自動判定せず、TPMは要求しない。RPDはprovider側の日次reset時刻に依存せず、保守的なrolling 24時間窓で制限する。

```json
{
  "openrouter-nemotron": {
    "free": true,
    "provider": "openrouter",
    "dailyTier": "base",
    "quotas": [{
      "scope": "openrouter-free-models",
      "rpm": 20,
      "day": "rolling"
    }]
  }
}
```

Cloudflare Neuronsは`cloudflare-workers-ai-neurons`、OpenRouterは`openrouter-free-models`の固定scopeで分割を防ぐ。Cloudflare RPMも含む各次元は既存Luaスクリプトで一度に予約する。共有scopeの上限定義がモデル間で異なる設定は拒否し、Redis障害は予約不可としてfail closedにする。
複数の共有上限が適用される場合はquotasに全て列挙する。
同じscopeでは全モデルで同じ上限・日次方式を使用する（不一致設定は拒否）。
Googleはproject/modelの実共有範囲、Groqはorganization/modelおよび適用されるorganization共通範囲、
OpenRouterはaccountのfree共通枠、CloudflareはaccountのWorkers AI共通Neuronsを表すscopeにする。
APIキーごとに別scopeを作って共有quotaを分割しない。
このアプリ以外の同一quota消費も同じリミッターへ統合するか、その分を差し引いた内部上限を設定する。

GoogleはStage 1前にFacts待機leaseを登録し、Facts完了までコメントをブロックする。
実行中消費はRPM/TPMにも予約される。Googleコメントの日次上限はPTで `min(10000, rpd-4400)`。
枠不足では待たずスキップする。token数はUTF-8 byte数＋余裕＋最大出力で保守的に予約し、結果不明でも返却しない。
日次固定窓はカウンター、分窓・rolling日次は移動窓で全次元を1 Lua EVAL内で判定・消費する。
429はRetry-After、Google RetryInfo、Groqの残量0のreset headerでcooldownを延長する。不明時は60秒。
通常の予約は1 EVAL、Facts待機開始/終了は各1 EVAL、429は1 EVAL。全Topicで同じRedisを使用する。

Secrets：既存 `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` / `UPSTASH_REDIS_REST_URL` /
`UPSTASH_REDIS_REST_TOKEN` / `GROQ_API_KEY` / `GEMINI_API_KEY`、新候補用 `OPENROUTER_API_KEY` /
`CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_AI_API_TOKEN`。値をログへ出さない。

## 未確認・有効化前の確認事項

実API/管理画面を使用していないため、実キーのquota、無料tier、31Bと26Bの共有範囲は未確認。
Google 26B/31Bのquota独立性が確認できない間はGoogleコメント候補を有効化しない。
31B retryへ共通Redis呼出を追加することは14.3に反するため実装していない。
公開値からアカウント固有の制限を推定せず、確認値を `AI_QUOTA_CONFIG` に設定する。
他の同一account利用がある場合のCloudflare Neurons残量、OpenRouterの日次50/1000区分、GroqのITPM/OTPMも確認対象。
残りのRedis月次枠とSupabase invocation枠は既存ニュース配信・Topic Processing分を含めて運用側で確認する。

公式確認先（2026-09-27）：

- [Google rate limits](https://ai.google.dev/gemini-api/docs/rate-limits)：project単位、PT日次reset、実上限はAI Studio。
- [Groq rate limits](https://console.groq.com/docs/rate-limits)：organization単位、ITPM/OTPMは組織ごとの差異あり。
- [Cloudflare Gemma](https://developers.cloudflare.com/workers-ai/models/gemma-4-26b-a4b-it/) / [pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)：Neurons共通無料枠。
- [OpenRouter limits](https://openrouter.ai/docs/api_reference/limits) / [Nemotron free](https://openrouter.ai/nvidia/nemotron-3-ultra-550b-a55b:free)：free固定モデルを指定。
- [Supabase background tasks](https://supabase.com/docs/guides/functions/background-tasks)：waitUntilにも実行時間上限あり。
- [Upstash limiter costs](https://upstash.com/docs/redis/sdks/ratelimit-ts/costs)：EVAL単位とread replica分の利用量を考慮。

## ローカル検証

```powershell
deno test --allow-env --allow-read --allow-write supabase/functions/generate-ai-replies/ supabase/functions/_shared/ai_rate_limit_test.ts supabase/tests/shared_ai_router_test.ts cloudflare/topic-pregen/src/index_test.ts
```

DBテストはPGliteの一時PostgreSQLへ既存/新規migrationを実行する。並行要求は組込みDBで直列化され、
31B先着/ルーター先着の両順序と同一試行再保存を検証する。実PostgreSQLの複数接続によるロック負荷試験は未実施。
Redisテストはメモリ内のRedisコマンド代替上で実際のLuaを実行する。Providerはモックのみ。

## 変更ファイル

- `supabase/functions/generate-ai-replies/shared_router.ts`：並列ルーター、無料Provider adapter、DB接続。
- `supabase/functions/generate-ai-replies/handler.ts`：初回APIとwaitUntil接続。
- `supabase/functions/generate-ai-replies/ai_replies.ts`：既存parserへの厳密10件検証オプション。
- `supabase/functions/_shared/ai_rate_limit.ts`：共通Redis quota、429、Facts待機。
- `supabase/functions/_shared/topic/gemma.ts` / `stage1.ts`、`supabase/functions/topic-processing/index.ts`：共通quota接続。
- `supabase/migrations/20260927093027_free_shared_ai_router.sql`：ジョブ、試行、共通採番、31B RPC、権限。
- `cloudflare/topic-pregen/src/index.ts`：31B成功結果も厳密10件検証。
- `supabase/functions/generate-ai-replies/shared_router_test.ts` / `handler_test.ts`：ルーター・APIテスト。
- `supabase/functions/_shared/ai_rate_limit_test.ts` / `ai_rate_limit_test_helpers.ts`：Lua実行テスト。
- `supabase/tests/shared_ai_router_test.ts`：組込みPostgreSQL検証。
- `deno.lock`：テスト用PGliteの固定依存。
- `docs/FEATURE_MAP.md`、本書：調査入口とAPI・設定契約。`CURRENT_SPEC.md`は未変更。
