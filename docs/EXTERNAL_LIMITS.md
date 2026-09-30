# External Service Limits

AI速が利用する外部API・DB・Redis・AIサービスの制限をまとめる。

この文書は、外部サービスによって課される quota、rate limit、容量、料金上の制約を確認するための資料とする。

AI速自体の動作・取得頻度・retry・fallback・quota管理等の仕様は `CURRENT_SPEC.md` を参照する。

外部サービスの制限は変更される可能性があるため、制限に影響する実装変更を行う場合は公式情報を再確認する。

---

## 1. NewsData.io

### Free Plan

| 項目              |                制限 |
| --------------- | ----------------: |
| API Credits     |         200 / day |
| Rate Limit      | 30 requests / 15分 |
| 記事遅延            |             約12時間 |
| `excludedomain` |       最大5 domains |

確認日: 2026-09-15

---

## 2. Google Gemma

### Gemma 4 26B

| 項目  |    制限 |
| --- | ----: |
| RPM |    30 |
| TPM |   16K |
| RPD | 14.4K |

確認日: 2026-09-15

### Gemma 4 31B (`gemma-4-31b-it`)

Google公式Release Notesで、`gemma-4-31b-it` が2026-04-02にリリースされ、Google AI Studio / Gemini APIから利用可能であることを確認済み。

Gemini APIのrate limitはproject単位で適用される。RPDはPacific Timeの00:00にresetされる。

31B固有のRPM / TPM / RPDについて、2026-09-24時点の公開公式ページから、この文書へ確定値として転記できる値は再確認できていない。サブ仕様で使用していた `RPM 30 / TPM 16K / RPD 14.4K` は、実装時にAI Studioの対象projectのquota表示または実API応答で再確認するまで確定値として扱わない。26Bと31Bのquotaが独立しているかについても、実アカウント表示を正とする。

31B最新Topicコメント事前生成では、Google側の上限とは別にアプリ内部制限として最大10 attempts / 任意の60秒窓を使用し、生成成功後は次の31B生成開始まで最低60秒のcooldownを設ける。この内部制限は外部quota値そのものではなく、AI速側の保守的な運用上限である。

確認日: 2026-09-24

公式情報源:
- https://ai.google.dev/gemini-api/docs/changelog
- https://ai.google.dev/gemini-api/docs/rate-limits

---

## 3. Gemini Thread Title Generation

### Gemini 3.1 Flash-Lite

| 項目  |   制限 |
| --- | ---: |
| RPM |   15 |
| TPM | 250K |
| RPD |  500 |

確認日: 2026-09-15

### Gemini 3.5 Flash-Lite

Gemini APIのrate limitはprojectおよびusage tierごとに異なり、実際のRPM / TPM / RPDはAI Studioの有効なproject limitsを正とする。公開rate limit資料はモデル別の一律RPM / RPDを保証しないため、Gemini 3.1 Flash-Liteの数値を流用しない。thread title workerの内部上限はCURRENT_SPECの490 requests / PT dayを維持する。

公式情報源: https://ai.google.dev/gemini-api/docs/rate-limits

確認日: 2026-09-27

---

## 4. Gemini Embedding

### Gemini Embedding 1

| 項目  |    制限 |
| --- | ----: |
| RPM |   100 |
| TPM |   30K |
| RPD | 1,000 |

### Gemini Embedding 2

| 項目  |    制限 |
| --- | ----: |
| RPM |   100 |
| TPM |   30K |
| RPD | 1,000 |

確認日: 2026-09-15

---

## 5. Supabase

### Free Plan

| 項目                        |               制限 |
| ------------------------- | ---------------: |
| Database API Requests     |        Unlimited |
| Database Size             | 500 MB / project |
| Egress                    |             5 GB |
| Cached Egress             |             5 GB |
| Edge Function Invocations |      500,000 / 月 |
| Edge Function Memory      |           256 MB |
| Edge Function Wall Clock  |             150秒 |
| Edge Function CPU Time    |     2秒 / request |
| Edge Functions            |    100 / project |
| Monthly Active Users      |       50,000 / 月 |
| Monthly Active Third-Party Users | 50,000 / 月 |
| Storage Size              |             1 GB |
| Realtime Concurrent Peak Connections | 200 |

※ Supabase Usage画面（2026-09-29）で確認した追加項目。Log Ingestion / Log Queryは同画面で `UPCOMING` と表示されているため、現行の適用済みquotaと区別する。

| 今後適用予定の項目 | Usage画面の表示値 | 状態 |
| --- | ---: | --- |
| Log Ingestion | 1 GB | UPCOMING |
| Log Query | 100 GB | UPCOMING |

追加項目の確認日: 2026-09-29（ユーザー提供のSupabase Organization Usage画面。プラン: Free、表示請求期間: 2026-09-22〜2026-10-22）。適用開始日や課金・制限動作は画面からは確認できない。

Database SizeがFree Planのquotaを超えると、read-only modeの対象となる。

### Cron

| 項目      | 制限・推奨                      |
| ------- | -------------------------- |
| 実行間隔    | every second ～ once a year |
| 同時実行    | 8 Jobs以下を推奨                |
| Job実行時間 | 10分以下を推奨                   |

※ 同時8 Jobs以下・実行時間10分以下はhard limitではなく、Supabase公式の推奨値。

Edge FunctionsのMemory / Wall Clock / CPU Time / Functions数は2026-09-24に公式情報で再確認し、既存値と一致。Database / Egress / Invocation等の既存値は本更新では変更していない。

確認日: 2026-09-24（Edge Functions再確認）

公式情報源:
- https://supabase.com/docs/guides/functions/limits

---

## 6. Upstash Redis

### Free Plan

| 項目               |          制限 |
| ---------------- | ----------: |
| Commands         | 500,000 / 月 |
| Data Size        |      256 MB |
| Bandwidth        |   10 GB / 月 |
| Max Commands/sec |      10,000 |
| Max Request Size |       10 MB |

2026-09-24にUpstash公式PricingでFree Planの500,000 commands/月、256 MB、10 GB/月、10,000 commands/sec、10 MB/requestを再確認し、既存値と一致。

確認日: 2026-09-24

公式情報源:
- https://upstash.com/pricing/redis

### Vector Free / Pay as You Go

Topic統合は既存の1536次元Upstash Vector indexでhosted embedding `openai/text-embedding-3-small` を使い、`upsert-data` / `query-data` にraw textを渡す。別途OpenAI接続は不要。Free枠は10,000 query/update units/日、超過後Pay as You Goは$0.40/100,000 units。1 vector upsert/updateを1 unit、1 queryを1 unitとして見積もる。Embedding provider固有の別rate limitは公開確認できていないため、運用開始時にConsoleの実績を確認する。

| 項目 | Free | Pay as You Go |
| --- | ---: | ---: |
| query / update | 10,000 / 日 | $0.40 / 100,000 request units |
| 最大次元 | 1,536 | 3,072 |
| 保存上限 | 1 GB | 50 GB |
| 保存料金 | 無料 | $0.25 / GB・月 |

Upsertは1 vectorごとにupdate 1 unit、検索はquery 1回ごとに1 unitとして見積もる。Topic workerは30秒間隔、最大1記事/run（最大2,880記事/日）のため、検索2,880回と、新規Topicが全記事で発生した場合のupsert最大2,880件を合わせて最大5,760 units/日。2026-09-26のbackfillは71 vector updates。検証の71件fetchを各1 unit、類似検索1 unitと保守的に加算し、ユーザー提供の当日1,497件を基準にした初回最大見積もりは7,400/10,000 units。Freeプラン内だが、別用途の将来消費はこの見積もりに含まない。公式公開資料で確認できた上限は日次query/update unitsで、別のRPMは確認できていない。2026-09-26確認。

公式情報源:
- https://upstash.com/pricing/vector
- https://upstash.com/docs/vector/api/endpoints/upsert-data
- https://upstash.com/docs/vector/api/endpoints/query-data
- https://upstash.com/docs/vector/features/embeddingmodels
- https://upstash.com/docs/vector/features/namespaces
- https://upstash.com/docs/vector/help/faq

---

## 7. OpenRouter

### Free Models

| 項目               |                 制限 |
| ---------------- | -----------------: |
| 無課金アカウント         |    50 requests / 日 |
| $10以上credits購入済み | 1,000 requests / 日 |
| Rate Limit       |    20 requests / 分 |

個別モデル・Providerには、これとは別の制限が設定される場合がある。

確認日: 2026-09-15

---

## 8. Groq

Groqのrate limitはorganization単位で適用され、RPM / RPD / TPM / TPD / ITPM / OTPMのうち最初に到達した制限によって429となる。

共通rate limit:

* RPM: Requests Per Minute
* RPD: Requests Per Day
* TPM: Tokens Per Minute
* TPD: Tokens Per Day
* ITPM: Input Tokens Per Minute
* OTPM: Output Tokens Per Minute

ITPM / OTPMは一部organizationにTPMとは別に設定される。正確なITPM / OTPMはGroq ConsoleのOrganization Limitsを正とする。ITPM / OTPMはorganization levelで適用され、project側でorganization上限を超える値にはできない。Project側ではorganization上限以下の、より制限的な値のみ設定できる。

公式ドキュメント掲載値と実アカウントの制限が異なる場合は、Groq ConsoleのLimits画面に表示される値を正とする。

### GPT-OSS 120B (`openai/gpt-oss-120b`)

| 項目 | 制限 |
| --- | ---: |
| RPM | 30 |
| RPD | 1,000 |
| TPM | 8,000 |
| TPD | 200,000 |
| Context Window | 131,072 tokens |
| Max Output Tokens | 65,536 |

### GPT-OSS 20B (`openai/gpt-oss-20b`)

| 項目 | 制限・価格 |
| --- | ---: |
| Context Window | 131,072 tokens |
| Max Output Tokens | 65,536 |
| 公開価格（入力 / 出力） | $0.075 / $0.30 per 1M tokens |

Groqの現行model cardではJSON Schema structured outputに対応する。Organization固有のRPM / RPD / TPM / ITPM / OTPMはConsoleのLimitsを正とし、120Bの値を流用しない。

### Qwen 3.8 27B (`qwen/qwen3.8-27b`)

| 項目 | 制限 |
| --- | ---: |
| RPM | 30 |
| RPD | 1,000 |
| TPM | 8,000 |
| TPD | 200,000 |
| Context Window | 131,042 tokens |
| Max Output Tokens | 16,384 tokens |
| OTPM | 1,000 / 分（2026-09-22 実アカウントAPI応答で確認） |
| 公開価格（入力 / 出力） | $0.80 / $4.00 per 1M tokens |

Qwen 3.8 27BのOTPM 1,000は全Groqユーザー共通値とは断定しない。現在使用しているorganizationで2026-09-22にAPI応答から実測した値であり、Groq ConsoleのOrganization Limitsを正とする。

`Max Output Tokens 16,384`はモデル自体の1レスポンス上限であり、`OTPM 1,000`はorganizationの1分あたり出力token制限であるため別物である。今回の実測では`max_tokens: 1200`を指定しただけで、`OTPM Limit 1000 / Requested 1200`として生成開始前に429（`rate_limit_exceeded`）となった。Benchmark等でこのorganizationからQwenを呼ぶ場合、現状は`max_tokens <= 1000`にする必要がある。

GPT-OSS 120Bについて、QwenでOTPM 1,000が確認されたことだけを根拠にOTPM値を推測しない。GPT-OSSにもorganization固有のITPM / OTPMが存在する可能性があるため、Organization Limitsを確認する。

GPT-OSS 120Bは`reasoning_effort`の`low` / `medium` / `high`をサポートし、既定は`medium`。Qwen 3.8 27Bは`none` / `default`に加えて`low` / `medium` / `high`をサポートし、既定は`none`。未対応の`reasoning_effort`値は400となる。reasoning tokenを使用する設定ではtoken制限への影響を考慮する。

### Rate Limit Headers

Groqは運用確認用に以下のheaderを返す。

* `retry-after`
* `x-ratelimit-limit-requests`
* `x-ratelimit-remaining-requests`
* `x-ratelimit-limit-tokens`
* `x-ratelimit-remaining-tokens`
* `x-ratelimit-reset-requests`
* `x-ratelimit-reset-tokens`

公式仕様ではrequest系headerはRPD、token系headerはTPMを表す。これらのheaderだけでorganization固有のITPM / OTPMを必ず取得できるとは限らない。

確認日: 2026-09-22

公式情報源:
- https://console.groq.com/docs/rate-limits
- https://console.groq.com/docs/model/qwen/qwen3.8-27b
- https://console.groq.com/docs/projects
- https://console.groq.com/docs/reasoning
- https://console.groq.com/docs/model/openai/gpt-oss-120b
- https://console.groq.com/docs/api-reference

---

## 9. Cloudflare

### Workers Free

| 項目 | 制限 |
| --- | ---: |
| Requests | 100,000 / 日 |
| Reset | 00:00 UTC |
| CPU Time | 10 ms / invocation |
| Memory | 128 MB |
| External Subrequests | 50 / request |
| Simultaneous outgoing connections | 6 / request |

ネットワークI/O待ちはCPU timeには含まれない。Free Planの日次request上限は00:00 UTCにresetされる。

### Durable Objects / Alarms (Workers Free)

Durable ObjectsはWorkers Freeでも利用可能。ただしFree Planで新規作成・利用できるのはSQLite-backed Durable Objectsのみ。

| 項目 | Workers Free |
| --- | ---: |
| Durable Object Requests | 100,000 / 日 |
| Duration | 13,000 GB-s / 日 |
| SQLite Rows Read | 5 million / 日 |
| SQLite Rows Written | 100,000 / 日 |
| SQLite Stored Data | 5 GB total |
| Durable Object Classes | 100 / account |
| Storage / Durable Object | 10 GB |
| CPU / request | 30秒 default（最大5分へ設定可能） |
| Simultaneous outgoing connections | 6 / request |

Durable Object requestにはHTTP request、RPC session、WebSocket message、Alarm invocationが含まれる。`setAlarm()` はSQLite storage上の1 row writeとして課金・quota計上される。Free Planの日次上限は00:00 UTCにresetされる。

31B Challengerではsingleton Durable Object + Alarmを使用し、最新Topic 1件の状態とretry時刻だけを保持する。31B retryをSupabase Edge Function invocation、Supabase DB read、Upstash commandへ伝播させない。アプリ内部上限は最大10 attempts / 任意の60秒窓、成功後最低60秒cooldownとする。

確認日: 2026-09-24

公式情報源:
- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/workers/platform/pricing/
- https://developers.cloudflare.com/durable-objects/platform/pricing/
- https://developers.cloudflare.com/durable-objects/platform/limits/

### Workers AI

| 項目                    |                     制限 |
| --------------------- | ---------------------: |
| Free Allocation       |     10,000 Neurons / 日 |
| Free Allocation Reset |              00:00 UTC |
| Text Generation既定Rate Limit | 300 requests / 分 |
| Workers Paid超過料金      | $0.011 / 1,000 Neurons |

Free AllocationはWorkers AI全モデルで共有する。10,000 Neurons / 日を超えて利用するにはWorkers Paidが必要。モデルごとにPaid限定または個別rate limitが設定される場合がある。

### Gemma 4 26B A4B (`@cf/google/gemma-4-26b-a4b-it`)

| 項目 | 制限・単価 |
| --- | ---: |
| Workers Free利用 | 可 |
| Rate Limit | 300 requests / 分（Text Generation既定） |
| Context Window | 256,000 tokens |
| Input | 9,091 Neurons / 1M tokens |
| Output | 27,273 Neurons / 1M tokens |
| Token換算価格 | $0.10 / 1M input tokens |
| Token換算価格 | $0.30 / 1M output tokens |

Gemma 4専用のRPDは公開されておらず、FreeではWorkers AI共通の10,000 Neurons / 日が実質的な日次quotaとなる。入力・出力token比率によって1日に実行できるrequest数は変動する。

公式情報源:
- https://developers.cloudflare.com/workers-ai/platform/pricing/
- https://developers.cloudflare.com/workers-ai/platform/limits/
- https://developers.cloudflare.com/workers-ai/models/gemma-4-26b-a4b-it/

### Vectorize

| 項目                          |                     Workers Free |
| --------------------------- | -------------------------------: |
| Queried Vector Dimensions   |                   30 million / 月 |
| Stored Vector Dimensions    |                    5 million / 月 |
| Indexes / account           |                              100 |
| Maximum Dimensions / Vector |                            1,536 |
| Maximum Vectors / Index     |                       20,000,000 |
| Maximum Namespaces / Index  |                            1,000 |
| Maximum Metadata / Vector   |                           10 KiB |
| Maximum Upsert Batch        | Workers: 1,000 / HTTP API: 5,000 |
| Maximum Vector Upload Size  |                           100 MB |

確認日: 2026-09-20

---

## 10. 更新ルール

外部サービスの制限値を追加・更新する場合は、可能な限り以下を記録する。

* 制限値
* 対象プラン
* 確認日
* 公式情報源

現在の使用量など、頻繁に変動する値はこのファイルには記録しない。

外部サービスの公式情報と本ファイルの記載が食い違う場合は、公式情報を正とする。
