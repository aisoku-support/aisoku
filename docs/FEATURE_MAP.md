# 機能からコードへの索引

確認日: 2026-09-17

本書は、機能・症状から調査開始位置へ到達するための索引である。

- `docs/CURRENT_SPEC.md` = 現在どう動くべきか
- `docs/FEATURE_MAP.md` = どのコードから調べるか、変更時にどこへ影響し得るか
- 過去の仕様書・仕様変更書 = 変更理由や過去挙動の確認用

本書で新仕様を決定しない。

CURRENT_SPECの仕様本文を重複して保持しない。

稼働中の外部サービス設定は、本書記載だけでは保証しない。

## 読み方

1. [AGENTS.md](../AGENTS.md) を確認する。
2. 下の早見表から対象機能を特定する。
3. [CURRENT_SPEC.md](CURRENT_SPEC.md) の対応章だけ確認する。
4. 本書の「調査開始」でクラス名・メソッド名・状態変数を検索する。
5. 直接関係するコード、依存先、テストだけ確認する。
6. 原因を追えない場合のみ、調査範囲を段階的に広げる。
7. 関連経路を変更した場合は本書の該当項目だけ更新する。

影響調査では、まず対象機能のFEATURE_MAPを確認し、記載された「直接依存」「影響先」「共有基盤」「関連テスト」を初期影響範囲とする。実コードではその範囲を検証し、FEATURE_MAPと実コードが食い違う場合、または影響経路を特定できない場合だけ段階的に調査範囲を広げる。

今後、コード変更によって依存関係・影響先・調査入口・主要Service・状態管理・テスト構成が変わった場合は、実装変更と同じ変更でFEATURE_MAPの該当項目も更新する。

行番号は陳腐化しやすいため使用せず、検索可能なシンボルを記載する。

「Edge: なし」は、その処理経路からEdge
Functionへの直接呼び出しがないことを示す。

「メモリ」は画面・Controller等の存続中だけの状態であり、端末への永続保存とは区別する。

## 影響範囲マップ（変更元 → 影響先）

下表は、各機能の節にある詳細記載を横断して見るための初期影響範囲である。「直接依存」は変更元が直接呼び出す／読む相手、「影響先」は変更元を変えたときに最低限確認する別機能、「共有基盤」は複数機能が共用するため変更時に追跡する入口を示す。

| 変更元                                           | 直接依存                                                                                                            | 影響先                                                                                                                                                                                                                                                                   | 共有基盤                                                                                                                                                                          | 影響確認テスト                                                                                                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ニュース一覧（`NewsHomeController`）             | `NewsCacheService`、`TopicCacheService`、`UpstashNewsCacheService`、`NewsItem`、`hiddenHosts`                       | カテゴリ、段階表示、RSS、サイト非表示、保存ニュース、ニュース広告                                                                                                                                                                                                        | `NewsHomePage`、`NewsHomeHome`、SharedPreferences                                                                                                                                 | `news_swipe_test.dart`、`news_home_controller_pagination_test.dart`、`hidden_sites_test.dart`、`news_native_ads_test.dart`                                     |
| NewsData取得・保存                               | `update-newsdata`、`_shared/newsdata/*`、`newsdata_cron.sql`、Upstash `news:topics`                                 | ニュース一覧、カテゴリ、Topic V1基盤                                                                                                                                                                                                                                     | NewsData scheduler/store、Topic enqueue                                                                                                                                           | `newsdata_migration_test.dart`、`supabase/functions/_shared/newsdata/*_test.ts`                                                                                |
| カテゴリタブ                                     | `NewsCategoryViewState`、`ScrollableCategoryTabs`、`NewsHomeController`                                             | ニュース一覧、段階表示、ニュース広告、保存ニュース                                                                                                                                                                                                                       | `NewsHomePage`のPageView／タブ同期、SharedPreferences `reordered_news_categories`                                                                                                 | `news_category_view_state_test.dart`、`news_swipe_test.dart`、`category_reorder_test.dart`                                                                     |
| RSS追加・削除／キャッシュ                        | `RssService`、`RssDiscoveryService`、`ensure-rss-feed`、`UpstashNewsCacheService`                                   | RSS表示、定期巡回、ニュース一覧、保存ニュース                                                                                                                                                                                                                            | `RssFeed`、Redis `news:feed:<URL>`                                                                                                                                                | `rss_discovery_sheet_test.dart`、`hidden_sites_test.dart`                                                                                                      |
| RSS定期巡回                                      | `update-news-cache`、`touch-rss-feeds`、RSS parser、Upstash                                                         | RSS表示、ニュース一覧                                                                                                                                                                                                                                                    | Redis feed cache、Cron／scheduled invocation                                                                                                                                      | `supabase/functions/update-news-cache/rss_parser_test.ts`                                                                                                      |
| ローカル運用ダッシュボード | tools/operations-dashboard/server.js、HTML/CSS/JS、supabase/functions/topic-processing/index.ts、_shared/topic/stage1.ts／gemma.ts／log.ts／queue.ts／article_body.ts／upstash_vector.ts、_shared/ai_rate_limit.ts、cloudflare/topic-pregen/src/index.ts、20260926113156_add_topic_observability_logs.sql、20260929001905_add_thread_title_retry_and_body_observability.sql、20260929084503_operations_dashboard_diagnostic_details.sql、20260929114948_add_topic_stage2_defer_state.sql | Flutter本体およびニュース処理・生成・公開条件への影響なし。運用状況は読み取り専用。共通診断パネルは初期折りたたみで、Cloudflare Pregen状態は手動更新時のみ取得しポーリングしない | Supabase topic_processing_logs／topic_observability_logs（7日保持、Stage 2失敗の任意診断JSONBは最大4KB）／thread-title queue・batch／topic_vector_outbox／Topics、Upstashの既存NewsData・RSS state、Cloudflare Topic Pregen status | 既存ログと集計を維持し、Stage／本文取得／タイトル／NewsData／Vector・Outboxの詳細を安全な識別子・ドメイン・HTTP・retry・最終結果で展開表示。生成本文・記事本文・URL query・Secretは表示しない。quota判定／通信分類、Readabilityのnull・例外・空本文を区別。処理監視は既存の実行・queue・schedule情報だけを使用し、周期が不明なら「監視情報不足」。topic-processing配備境界はv83〜v90で版別表示し、再発と未解決状態を区別。新しいAI生成・記事再取得・Redis/Vector/API監視呼び出しなし | tools/operations-dashboard/server.test.js、tools/operations-dashboard/app.test.js、supabase/functions/_shared/topic/stage1_test.ts、gemma_test.ts、queue_test.ts、ai_rate_limit_test.ts、log_test.ts、article_body_test.ts、thread_title_test.ts、supabase/functions/generate-ai-replies/ai_replies_test.ts、cloudflare/topic-pregen/src/index_test.ts |
| ニュース詳細                                     | `NewsDetailController`、`NewsItem`、Partial Custom Tab、`ReplyCacheService`                                         | sharedAi、user投稿、localAi、アンカー、ジャンプ、スクロール、広告、保存                                                                                                                                                                                                  | `NewsDetailPage`、`NewsDetailReplySheet`                                                                                                                                          | `reply_sheet_responsiveness_test.dart`、`post_button_visibility_test.dart`                                                                                     |
| sharedAi／localAi生成                            | `AiService`、`generate-ai-replies`、`ReplyCacheService`、`ConversationPlan`、最新Topic 31B事前生成                  | AI掲示板表示、アンカー、広告、通報、投稿後ジャンプ                                                                                                                                                                                                                       | `NewsDetailController`、`ReplyItem`、`thread_chunks`、Cloudflare Topic Pregen DO                                                                                                  | `conversation_pattern_test.dart`、`reply_submission_analysis_test.dart`、`generate-ai-replies/ai_replies_test.ts`、`cloudflare/topic-pregen/src/index_test.ts` |
| user投稿・レス操作                               | `NewsDetailController`、`ReplyItem`、`ReplyCacheService`、`AiReplyReportService`                                    | localAi、アンカー、ジャンプ、AI掲示板表示、保存                                                                                                                                                                                                                          | `ReplyCard`、`NewsDetailReplyEntry`                                                                                                                                               | `reply_card_test.dart`、`reply_input_state_test.dart`、`ai_reply_report_test.dart`                                                                             |
| AI掲示板表示・スクロール                         | `NewsDetailReplySheetState`、`NewsDetailReplyEntry`、`NewsDetailReplyBottom`、`ReplyAdPolicy`                       | 投稿、アンカー、ジャンプ、広告、レス通報                                                                                                                                                                                                                                 | `NewsDetailReplySheet`、`ReplyItem`                                                                                                                                               | `reply_bottom_layout_test.dart`、`reply_entry_layout_test.dart`、`reply_sheet_responsiveness_test.dart`                                                        |
| `ReplyCacheService`／`articles`・`thread_chunks` | `NewsDetailController`、Supabase `articles`／`thread_chunks`                                                        | sharedAi、localAi、user投稿、保存ニュース、AI掲示板表示                                                                                                                                                                                                                  | publishable keyによる直接SELECT/限定カラムUPDATE/INSERT、unique conflict時の既存article再取得、DB schema。engagement分析のみRPC                                                     | `reply_cache_service_test.dart`、`load_more_error_test.dart`、`saved_thread_service_test.dart`                                                                 |
| AdMob／`ReplyAdPolicy`                           | `AdConsentService`、`NativeAdSlot`、`ThreadAdSession`、Android factory、`record_monetization_events` RPC            | ニュース一覧、AI掲示板、設定、AI生成計測                                                                                                                                                                                                                                 | `NewsHomePage`、`NewsDetailController`、`AdPlacement`                                                                                                                             | `ad_consent_test.dart`、`ad_lifecycle_test.dart`、`reply_ad_policy_test.dart`、`monetization_analytics_test.dart`                                              |
| Topic V1基盤／Embedding                          | `topics`、`topic_articles`、`topic_processing_queue`、enqueue／claim／match RPC、`get-topic-sources`                | NewsData取得・保存、ニュース一覧、Topic worker、Topicカードのソース表示                                                                                                                                                                                                  | Supabase topic schema、legacy Gemini 384 vector、Upstash Vector `topic-openai-v1`／Upstash Redis `news:topics`／`newsdata:article:*`                                                     | Topic関連のEdge Functionテスト、`source_store_test.ts`、NewsData scheduler／migrationテスト（該当変更時）                                                      |
| Topic worker                                     | `topic-processing`、Groq Stage 1／Gemma Stage 2 client、Gemini／Upstash Vector client、topic store、commit RPC、Stage 1／Vector検索／Outbox observability、thread-title確定後のbest-effort 31B通知          | Topic一覧、ニュース一覧、Embedding／merge結果                                                                                                                                                                                                                            | topic queue（Stage 2延期予定時刻・累積attempt上限）、processing logs、legacy Gemini 384 schema、Upstash Vector `topic-openai-v1`、Cloudflare singleton DO                                                                                                       | Topic workerのEdge Functionテスト、`gemma_test.ts`、`queue_test.ts`、`ai_rate_limit_test.ts`、`log_test.ts`、`thread_title_test.ts`、`cloudflare/topic-pregen/src/index_test.ts`                                                         |
| サイト非表示                                     | `HiddenSitesService`、`NewsHomeController`、`NewsHomePage`                                                          | ニュース一覧、RSS表示、保存ニュース                                                                                                                                                                                                                                      | `hiddenHosts`、SharedPreferences                                                                                                                                                  | `hidden_sites_test.dart`                                                                                                                                       |
| 保存ニュース                                     | `SavedThreadService`、`NewsHomeController`、`NewsHomeSaved`、`ReplyCacheService`                                    | ニュース一覧、ニュース詳細、RSS削除、サイト非表示                                                                                                                                                                                                                        | SharedPreferences `saved_news_urls`／`saved_news_archives_v1`                                                                                                                     | `saved_thread_service_test.dart`、`hidden_sites_test.dart`                                                                                                     |
| 外観（テーマ）設定                               | `ThemeService`、SharedPreferences (`theme_mode`)                                                                    | 全画面・全UIコンポーネント (テーマ切り替え)                                                                                                                                                                                                                              | `NewsApp` (`main.dart`)、`SettingsPage`                                                                                                                                           | `theme_service_test.dart`                                                                                                                                      |

共有基盤を変更した場合は、利用元を個別に確認する。特に`NewsHomeController`は一覧・カテゴリ・RSS・非表示・保存、`NewsDetailController`は詳細・AI生成・投稿・レス操作・広告、`ReplyCacheService`はAI掲示板・投稿・保存ニュースへ波及する。Supabase
RPC／テーブル、Redisキー、SharedPreferencesキーの変更は、呼び出し元だけでなくこの表の「影響先」も確認する。

## 早見表

| 機能 / 症状                                                               | 最初に調べる箇所                                                                        | 現行仕様                              |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------- |
| [ニュース一覧](#news-list) / 起動・更新・並び順                           | `NewsHomeController.initialize / loadNews / _applyFilteredNews`                         | `CURRENT_SPEC` 6章                    |
| [NewsData.io取得・保存・ログ](#newsdata) / 独立スケジュール・重複・エラー | NewsData取得用Edge Function、Upstash保存処理、Cron設定                                  | `CURRENT_SPEC` 6〜8章                 |
| [カテゴリタブ](#categories) / 順序・選択復元・横スクロール                | `NewsHomeController._updateCategories`、`ScrollableCategoryTabs`                        | `CURRENT_SPEC` 4〜5章                 |
| [ニュース段階表示](#paging) / 初期最大10件・50件追加取得・位置保持        | `loadMoreCurrentCategory / _loadMoreRpc`、`NewsHomeHome._handleScrollNotification`      | `CURRENT_SPEC` 6.3                    |
| [RSS追加・削除](#rss-edit)                                                | `NewsHomeFeedDialogs` / `RssDiscoverySheet` → `NewsHomeController.addFeed / removeFeed` | `CURRENT_SPEC` 9章                    |
| [ユーザーRSSキャッシュ](#upstash)                                         | `UpstashNewsCacheService.fetchNews` → `update-news-cache`                               | `CURRENT_SPEC` 9章                    |
| [ユーザーRSS定期巡回](#rss-poll)                                          | `update-news-cache` の `Deno.serve`、`touch-rss-feeds`                                  | `CURRENT_SPEC` 9章                    |
| [ニュース詳細 / Partial Custom Tab](#detail)                              | `NewsDetailPage`、`_launchPartialCustomTab`、`_handleScroll`                            | `CURRENT_SPEC` 10章                   |
| [AI sharedAi生成](#shared-ai)                                             | `NewsDetailController._getOrGenerateSharedChunk`                                        | `CURRENT_SPEC` 11〜14章               |
| [user投稿](#user-post)                                                    | `NewsDetailPage._postComment` → `NewsDetailController.postComment`                      | `CURRENT_SPEC` 15章                   |
| [localAi返信](#local-ai)                                                  | `_generateLocalAiRepliesInBackground`                                                   | `CURRENT_SPEC` 15章                   |
| [>> アンカー](#anchors)                                                   | `ReplyCard`、`ReplySubmissionAnalysis.analyze`、`_addRepliesToView`                     | `CURRENT_SPEC` 15.3、16章             |
| [投稿後ジャンプ](#post-jump)                                              | `requestJump` → `NewsDetailReplySheetState._performJump`                                | `CURRENT_SPEC` 16章                   |
| [AI掲示板スクロール / Overscroll](#scroll)                                | `NewsDetailReplySheetState.build / _correctScrollPositionIfNecessary`                   | `CURRENT_SPEC` 17章                   |
| [AI掲示板表示](#paging-ai) / レス・広告・生成状態                         | `NewsDetailReplyEntry`、`NewsDetailReplyBottom`                                         | `CURRENT_SPEC` 11、15、17〜18章       |
| [レス操作 / user削除 / AIレス通報](#reply-reports)                        | `ReplyCard._showActions`、`NewsDetailController` の削除・通報処理                       | `CURRENT_SPEC` 11.3〜11.4、13.4、20章 |
| [サイト非表示](#hidden-sites)                                             | `_hideSite`、`NewsHomeController.hideSite`、`HiddenSitesService`                        | `CURRENT_SPEC` 6.8                    |
| [AdMob / 広告](#ads)                                                      | `NewsHomeHome.build` / `ReplyAdPolicy`                                                  | `CURRENT_SPEC` 18章                   |
| [Supabase articles / thread_chunks](#database)                            | `ReplyCacheService.saveChunk / loadChunk / loadReplies`                                 | `CURRENT_SPEC` 13章                   |
| [保存ニュース](#saved)                                                    | `NewsHomeController.toggleSaved`、`NewsHomeSaved`                                       | `CURRENT_SPEC` 19章                   |
| [外観（テーマ）設定](#theme-settings)                                     | `ThemeService.init / setThemeMode`、`SettingsPage._showThemeDialog`                     | `CURRENT_SPEC` 21章                   |

## 機能別の関連範囲

<a id="news-list"></a>

### ニュース一覧

- 現行仕様: `CURRENT_SPEC` 6章「ニュース一覧」。
- 調査開始:

  - [NewsHomePage](../lib/pages/news_home_page.dart)
  - [NewsHomeHome](../lib/widgets/news_home_home.dart)
  - [NewsHomeController](../lib/pages/news_home_controller.dart)
  - `initialize`
  - `loadNews`
  - `_applyFilteredNews`
  - `refreshNews`
- UI:

  - [NewsCard](../lib/widgets/news_card.dart)
- Service:

  - [TopicCacheService](../lib/services/topic_cache_service.dart):
    生成済みTopic一覧キャッシュによる運営ニュース
  - [UpstashNewsCacheService](../lib/services/upstash_news_cache_service.dart):
    ユーザーRSS
  - [NewsCacheService](../lib/services/news_cache_service.dart)
  - [RssService](../lib/services/rss_service.dart) は `RSS` タブ用
- Model:

  - [NewsItem](../lib/models/news_item.dart)
  - [RssFeed](../lib/models/rss_feed.dart) はユーザーRSS用
- Edge:

  - 運営ニュース: `topic-processing` がSupabaseの生成済みTopicからUpstash
    `news:topics` を更新（FlutterからはUpstash読取のみ）
  - 運営ニュース追加取得: Supabase RPC
    `get_public_topic_page`（公開Topicのカーソルページング）
  - ユーザーRSS: `update-news-cache`
- 主な状態:

  - `_allNewsList`
  - `_displayNewsList`
  - `_newsLoadGeneration`
  - `hiddenHosts` (サイト非表示フィルタ用)
  - SharedPreferences `local_news_cache`（RSS）/
    `local_topic_list_cache`（運営ニュース）
  - Upstash `news:topics`（生成済みTopic一覧）
  - ユーザーRSS用 `news:feed:<URL>`
- 調査注意:

  - 運営ニュースとユーザーRSSを同一取得経路として扱わない。
  - 運営ニュースは生成済みTopic一覧キャッシュから取得し、FlutterからNewsData.io
    APIを直接呼ばない。
  - `RSS` タブだけがユーザー登録RSSを表示する。
  - NewsData.io公式カテゴリとアプリ表示カテゴリを分けて追う。
  - NewsData記事の複数公式カテゴリは保持し、対応する複数アプリカテゴリへの表示を許容する。
  - NewsData手動更新はAPI再取得ではなく保存済みキャッシュ再読込。
  - `NewsItem.category` の既存用途を確認し、NewsData公式カテゴリ /
    アプリカテゴリとの意味衝突を避ける。
  - 非表示サイトのフィルタリングが一覧再構築時に正しく適用されているか確認する。
- 起動・速度問題の場合のみ追加確認:

  - [main.dart](../lib/main.dart)
  - [StartupPerf](../lib/services/startup_perf.dart)
  - [NewsPerf](../lib/services/news_perf.dart)

<a id="newsdata"></a>

### NewsData.io取得・保存・ログ

- 現行仕様: `CURRENT_SPEC`
  のNewsData.io取得、保存、ログ、エラー処理に関する記述。
- 調査開始:

  - [update-newsdata/index.ts](../supabase/functions/update-newsdata/index.ts):
    運営専用認証、実行制御
  - `collect` は全triggerで `requestsPerFetch=1` と1 page上限を強制する。5分CronのDispatcherはschedulerが返す単一modeだけを処理し、`rotation_index` に従って期限到来modeを選ぶ。全triggerで既存job secret認証を使用する。
  - [_shared/newsdata/api.ts](../supabase/functions/_shared/newsdata/api.ts):
    API通信とエラー分類、quota exhausted検知
  - [_shared/newsdata/strategy.ts](../supabase/functions/_shared/newsdata/strategy.ts):
    1 request / run・1 page上限、requestログ、成功・失敗時のcredit計上
  - [_shared/newsdata/scheduler.ts](../supabase/functions/_shared/newsdata/scheduler.ts):
    V2 scheduler (JST Quota Day, normal / tech / subculture独立スケジュール、
    due modeをrotation_indexで単独選択、モード別予算、rate limit)
  - [_shared/newsdata/config.ts](../supabase/functions/_shared/newsdata/config.ts):
    V2運用設定 (5分Dispatcher、1 request/run、1 page、日次100 credits・15分30 credits、
    normal時間帯別interval、各mode予算)
  - [_shared/newsdata/normalize.ts](../supabase/functions/_shared/newsdata/normalize.ts):
    正規化・重複除去
  - [_shared/newsdata/store.ts](../supabase/functions/_shared/newsdata/store.ts):
    記事・ログ・V2状態管理 (newsdata:v2:state)
  - [newsdata_cron.sql](../supabase/sql/newsdata_cron.sql): `update-newsdata` を5分間隔に
    更新・有効化するSQL。対象jobの重複を防ぎ、適用後のjob設定を確認する。
  - Flutterの現行一覧読取・ローカル退避は
    [TopicCacheService](../lib/services/topic_cache_service.dart) の
    `fetchNews / loadLocal`（`news:topics` /
    `local_topic_list_cache`）。旧記事単位のFlutter読取実装
    `NewsDataCacheService`
    は削除済みで、サーバー側のNewsData記事保存とは無関係。
  - [scheduler_test.ts](../supabase/functions/_shared/newsdata/scheduler_test.ts)
    /
    [newsdata_test.ts](../supabase/functions/_shared/newsdata/newsdata_test.ts)
    /
    [reset_lag_test.ts](../supabase/functions/_shared/newsdata/reset_lag_test.ts):
    due mode rotation・24時間mock実行・1 request/page上限、quota reset lag / Probeの検証用テスト
  - [generate_cron.ts](../supabase/functions/_shared/newsdata/generate_cron.ts) が適用SQLを生成する。
  - [generate_cron_test.ts](../supabase/functions/_shared/newsdata/generate_cron_test.ts) が5分Cron生成と対象jobの重複防止を検証する。
- 基本取得条件:

  - `language=ja`
  - `country` は指定しない
  - normal / tech / subculture は独立した次回取得時刻で判定する
  - 同時に期限到来した場合は `rotation_index` に従い1 modeだけ選択する
  - 1回につき最大1 request・1 page（最大10件）。追加ページは取得しない
  - normal は時間帯別interval、日次上限80 credits
  - tech は120分間隔、日次上限12 credits
  - subculture は180分間隔、日次上限8 credits
  - 3 modeの共通日次上限は100 credits、直近15分の共通上限は30 credits
  - 余剰credit消化のための動的な取得頻度増加・予算返却は行わない
- エラー経路:

  - API / HTTP / timeout / JSON解析 / quota / rate
    limit等のエラーが1回発生した時点で、その実行の残りリクエストを中止する。
  - 自動retryは行わない。
  - エラー前に取得済みの記事は保存対象とする。
- 主な保存情報:

  - NewsData `article_id`
  - 正規化URL
  - title / description / source / published_at / image_url
  - NewsData公式カテゴリ
  - アプリカテゴリ
  - fetched_at
- カテゴリ対応:

  - トレンド:
    `top / world / politics / crime / domestic / environment / education / health / tourism`
  - エンタメ: `entertainment / sports / lifestyle / food`
  - サブカル: `other`
  - マネー: `business`
  - IT・ガジェット: `technology / science`
- 主なログ:

  - 実行開始・終了時刻
  - `requested_requests`
  - `successful_requests`
  - `raw_fetched`
  - `unique_in_run`
  - `already_known`
  - `new_articles`
  - エラー有無・発生request・種別・status/code/message
  - `elapsed_ms`
  - request単位のitems / status / elapsed / request_mode
  - モード別の次回取得時刻・credit使用状況
  - 補助取得のページ送り回数と各requestの新規 / 既知件数
- 調査注意:

  - V1の毎時100件は効率最適化前の検証用取得戦略。
  - `rotation_index` は互換状態として残るが、現行の取得判定には使用しない。
  - 現行は `normal / tech / subculture`
    の独立スケジュールで、モード別の次回取得時刻とcredits状態を基準に判定する。
  - 取得間隔、時間帯別interval、モード別予算、burst条件、最大ページ数、timeout、記事保持期間、ログ保持期間、カテゴリ対応表は設定箇所へ集約する。
  - NewsData APIキーをFlutter、ログ、仕様書へ出力しない。
  - 記事本文全文、APIレスポンス全文を診断ログへ保存しない。
  - Cron実行と手動実行を `trigger` 等で区別する。
  - 同一時間帯の二重実行でAPIクレジットを重複消費しないようにする。

<a id="categories"></a>

### カテゴリタブ

- 現行仕様: `CURRENT_SPEC`
  4章「ニュースカテゴリ」、5章「カテゴリタブ」、6章「ニュース一覧」。
- 調査開始:

  - [NewsHomePage](../lib/pages/news_home_page.dart)
  - [ScrollableCategoryTabs](../lib/widgets/scrollable_category_tabs.dart)
  - `ScrollableCategoryTabs._scrollToSelected`
  - `ScrollableCategoryTabs._updateArrowVisibility`
  - `NewsHomeController._updateCategories`
  - `NewsHomeController.setCategoryIndex`
  - `NewsHomeController.reorderCategories`
  - `NewsHomeController._restoreLastCategory`
- 運営カテゴリ:

  - `トレンド`
  - `エンタメ`
  - `サブカル`
  - `マネー`
  - `IT・ガジェット`
- ユーザーRSS:

  - ユーザーRSSが存在する場合のみ末尾に `RSS` を表示する。
- Service:

  - 運営カテゴリ: `TopicCacheService.fetchNews / loadLocal`
  - `RSS`: ユーザーRSS取得Service
- Edge:

  - カテゴリ切替からの直接呼び出しなし
- 主な状態:

  - SharedPreferences `last_selected_news_category`
  - SharedPreferences `reordered_news_categories`
  - Controllerの選択index
  - Widgetの横スクロール位置
- 調査注意:

  - 永続化しているのはindexではなくカテゴリ名。
  - 保存カテゴリ名の読み込みと、categories構築後の選択index適用を分けて確認する。
  - 矢印タップとカテゴリ選択を混同しない。
  - `RSS` はユーザーRSS有無で存在自体が変わる。
  - `スポーツ` 独立タブは使用せず、NewsData公式 `sports` は `エンタメ`
    へ分類する。
  - `サブカル` 0件は正常状態。
  - NewsDataのカテゴリ対応表はUIコードへ重複定義しない。

<a id="paging"></a>

### ニュース段階表示

- 現行仕様: `CURRENT_SPEC` 6.3「運営カテゴリの段階表示」。
- 調査開始:

  - [NewsHomeHome](../lib/widgets/news_home_home.dart)
  - `NewsHomeHome._handleScrollNotification`
  - `NewsHomeController.loadMoreCurrentCategory / _loadMoreRpc`
  - `NewsHomeController.refreshNews / loadNews`
- State:

  - [NewsCategoryViewState](../lib/models/news_category_view_state.dart):
    `getVisibleCount / loadMore / resetForRefresh`
- 主な状態:

  - `_allNewsList` / `_categoryNewsLists`
  - `_categoryHasMore` / `_categoryIsLoadingMore`
  - ViewState内の `_visibleCounts`
  - ViewState内の `_scrollVersions`
- Service / DB:

  - [TopicCacheService](../lib/services/topic_cache_service.dart):
    初期キャッシュ読取とRPC応答の `parseTopic`
  - [topic_cache.ts](../supabase/functions/_shared/topic/topic_cache.ts):
    `perCategoryLimit`、公開キャッシュ `news:topics` の構築
  - [get_public_topic_page](../supabase/migrations/20260915100000_add_public_topic_page_rpc.sql):
    公開Topicのカーソルページング
- Edge:

  - ページングからEdge
    Functionへの直接呼び出しはなし。ただし、取得済み候補の末尾ではFlutterからSupabase
    RPC `get_public_topic_page` を直接呼ぶ。
- 調査注意:

  - `loadMoreCurrentCategory`
    は未表示の取得済み候補があればメモリ内表示上限を50件分増やし、候補をすべて表示済みなら
    `_loadMoreRpc` へ進む。
  - `_loadMoreRpc` は
    `p_category / p_cursor_created_at / p_cursor_topic_id / p_limit: 50`
    を送信し、取得結果を統合して表示上限を増やす。カーソルは非表示サイトを含む取得済み候補から決める。
  - 取得結果が50件未満なら次ページなしとする。同一カテゴリの取得中は重複RPCを抑止する。
  - 初期キャッシュは各カテゴリ最大10件。ViewStateの `defaultPageSize`
    と更新時の内部表示上限は50件であり、初期キャッシュ件数・実表示件数とは別。
  - `refreshNews`
    成功時は運営ニュース候補を初期キャッシュへ置き換え、表示上限・スクロール世代・ページング状態をリセットする。通常のカテゴリ切替と混同しない。
  - RPC追加取得ではSupabaseへの通信があるが、NewsData.io
    API・Upstash・RSSを追加取得しない。メモリ内の表示上限拡大だけなら通信しない。
  - スクロール位置と表示件数はカテゴリ単位で追う。`RSS`
    タブは50件段階表示の対象外。
  - `_startReveal` はデータ取得・ページングとは別の見た目用段階表示。

<a id="rss-edit"></a>

### RSS追加・削除

- 現行仕様: `CURRENT_SPEC` 9章「RSS管理」。
- 調査開始:

  - [NewsHomeRss](../lib/widgets/news_home_rss.dart)
  - `NewsHomePage._addFeed`
  - `NewsHomePage._deleteFeed`
  - [NewsHomeFeedDialogs](../lib/widgets/news_home_feed_dialogs.dart)
  - `NewsHomeController.addFeed`
  - `NewsHomeController.removeFeed`
  - `NewsHomeController.saveUserFeeds`
- Service:

  - `RssService.fetchFeedTitle`
  - `NewsCacheService.ensureRssFeedExists`
- Model:

  - `RssFeed`
  - `NewsItem`
- Edge:

  - [ensure-rss-feed](../supabase/functions/ensure-rss-feed/index.ts)
  - `ensure-rss-feed` はFlutter直呼びのPublishable
    KeyをFunction内で検証（`@supabase/server` `auth: "publishable"`、deploy
    `verify_jwt=false`）。OPTIONS preflightは認証対象外。Redis操作は
    `handler_test.ts` でmock確認。
  - [discover-rss-feed](../supabase/functions/discover-rss-feed/index.ts)（ニュースカードからの候補探索・検証のみ）
  - `discover-rss-feed` はFlutter直呼びのPublishable
    KeyをFunction内で検証（`@supabase/server` `auth: "publishable"`、deploy
    `verify_jwt=false`）。OPTIONS preflightは認証対象外。
- ニュースカードからのRSS探索:

  - [NewsHomePage](../lib/pages/news_home_page.dart) `_exploreRss`
  - [RssDiscoverySheet](../lib/widgets/rss_discovery_sheet.dart)
  - [RssDiscoveryService](../lib/services/rss_discovery_service.dart)
  - [RssDiscoveryCandidate](../lib/models/rss_discovery_candidate.dart)
  - [RSS探索Widgetテスト](../test/rss_discovery_sheet_test.dart)
  - [RSS探索Edgeテスト](../supabase/functions/discover-rss-feed/discover_test.ts)
  - [RSS探索handler認証テスト](../supabase/functions/discover-rss-feed/handler_test.ts)
- 主な状態:

  - SharedPreferences `rss_feed_names`
  - SharedPreferences `rss_feed_urls`
  - Controller `userFeeds`
  - Upstash `rss:urls`
  - Upstash `rss:meta:<URL>`
  - Upstash `rss:active`
- 調査注意:

  - RSS機能は運営ニュース取得元ではなく、ユーザー専用の `RSS` タブとして扱う。
  - 端末からRSSを削除しても共有Redis登録を削除する処理ではない。
  - ユーザーRSSの表示名と共有RSSのmetaを混同しない。
  - Edge側meta更新は既存フィールドを維持するマージ処理を確認する。

<a id="upstash"></a>

### ユーザーRSSキャッシュ

- 現行仕様: `CURRENT_SPEC` 9章のユーザーRSS関連仕様。
- 調査開始:

  - `NewsHomeController.initialize`
  - [UpstashNewsCacheService](../lib/services/upstash_news_cache_service.dart)
  - `fetchNews`
- ローカル退避:

  - [NewsCacheService](../lib/services/news_cache_service.dart)
- Model:

  - `RssFeed`
  - `NewsItem`
- Edge:

  - [update-news-cache](../supabase/functions/update-news-cache/index.ts)
  - `saveToUpstash`
- 主なUpstashキー:

  - `rss:urls`
  - `rss:active`
  - `rss:meta:<URL>`
  - `news:feed:<URL>`
  - `rss:update:cursor`
- 調査注意:

  - この節のRSSキャッシュはユーザー追加RSS用。
  - 運営ニュースのNewsData記事保存先と混同しない。
  - `rss:presets` を運営ニュース取得・表示の正として使用しない。
  - Flutterは読取経路、Edge Functionは書込経路として分けて追う。
  - FlutterのUpstash設定は `.env` の `UPSTASH_REDIS_REST_URL` と読取専用
    `UPSTASH_REDIS_REST_READ_ONLY_TOKEN`。書込tokenはクライアントへ置かない。
  - Edge側RSS解析とFlutter側RSS直接取得のパーサーは同一実装ではない。
  - Upstashキャッシュ上限とRSS直接取得件数を混同しない。

<a id="rss-poll"></a>

### ユーザーRSS定期巡回

- 現行仕様: `CURRENT_SPEC` 9章のユーザーRSS関連仕様。
- 調査開始:

  - [update-news-cache/index.ts](../supabase/functions/update-news-cache/index.ts)
  - `Deno.serve`
  - `updateFeed`
  - `fetchFeed`
  - `parseRss`
  - [rss_parser.ts](../supabase/functions/update-news-cache/rss_parser.ts)
  - [rss_parser_test.ts](../supabase/functions/update-news-cache/rss_parser_test.ts)
  - `saveToUpstash`
- active更新:

  - `NewsHomeController.initialize`
  - `NewsCacheService.touchRssFeeds`
- Edge:

  - [touch-rss-feeds](../supabase/functions/touch-rss-feeds/index.ts)
  - `touch-rss-feeds` はFlutter直呼びのPublishable
    KeyをFunction内で検証（`@supabase/server` `auth: "publishable"`、deploy
    `verify_jwt=false`）。Redis確認・更新は `handler_test.ts` でmock。
  - [ensure-rss-feed](../supabase/functions/ensure-rss-feed/index.ts)
  - [update-news-cache](../supabase/functions/update-news-cache/index.ts)
  - `update-news-cache/auth.ts` はCron専用Functionの `NEWS_CACHE_JOB_SECRET` を
    `x-news-cache-job-secret` で検証する。Gateway JWT検証は無効化し、認証は
    `auth_test.ts` でmock確認する。
- 主な状態:

  - Upstash `rss:active`
  - Upstash `rss:update:cursor`
  - Upstash `rss:urls`
  - Upstash `rss:meta:<URL>`
  - Upstash `news:feed:<URL>`
- 調査注意:

  - 定期巡回対象は最近利用されたユーザーRSSを基本とし、運営プリセットRSSを常時巡回対象として扱わない。
  - `rss:urls` 全件巡回と誤認しない。
  - `rss:presets` は運営ニュース表示・巡回の正ではない。
  - Dart側 `NewsItem` とEdge内TypeScriptの `NewsItem` は別定義。
  - Cronの実行頻度・認証・デプロイ済みversionはローカルコードだけで断定しない。
  - RSS取得失敗時に既存ニュースを空データで上書きしない処理を確認する。
- 運用変更時のみ追加確認:

  - [register_candidate_feeds.ps1](../tools/rss/register_candidate_feeds.ps1)

<a id="detail"></a>

### ニュース詳細 / Partial Custom Tab

- 現行仕様: `CURRENT_SPEC` 10章「ニュース詳細」。
- 調査開始:

  - `NewsHomePage._openNews`
  - [NewsDetailPage](../lib/pages/news_detail_page.dart)
  - `_launchPartialCustomTab`: Partial Custom Tab 起動
  - `_handleScroll`: 元記事リンクの表示・非表示制御
  - `NewsDetailController.loadInitialReplies`
- Model:

  - `NewsItem`
- Android 連携:

  - [MainActivity](../android/app/src/main/kotlin/com/aisoku/app/MainActivity.kt)
    の `launchPartialCustomTab`
  - `news_app/custom_tabs` MethodChannel
- 主な状態:

  - `_isPartialTabActive`
  - `_isLinkVisible`
  - `NewsDetailController.articleTitle`
- 調査注意:

  - AppBar 直下の「○○で読む ↗」が唯一の元記事導線。
  - スクロール方向に応じて元記事リンクがアニメーションで収納・再表示される。
  - 投稿ボタンや三点リーダー連携による前面復帰ロジックを確認する。

<a id="shared-ai"></a>

### AI sharedAi生成

- 現行仕様: `CURRENT_SPEC`
  11章「AIレスデータ」、12章「共有AIチャンク」、13章「Supabase
  AI共有キャッシュ」、14章「AI生成」。
- 調査開始:

  - [NewsDetailController](../lib/controllers/news_detail_controller.dart)
  - `loadInitialReplies`
  - `loadMoreReplies`
  - `_getOrGenerateSharedChunk`
  - `_saveSharedChunkSafely`
- Service:

  - [AiService](../lib/ai_service.dart)
  - `AiService.generateReplies`
  - [ReplyCacheService](../lib/reply_cache_service.dart)
- Edge:

  - [generate-ai-replies](../supabase/functions/generate-ai-replies/index.ts)
  - [ai_replies.ts](../supabase/functions/generate-ai-replies/ai_replies.ts)
  - Publishable KeyはFunction内で `@supabase/server` の `auth: "publishable"`
    により検証し、deployは `verify_jwt=false`。認証テストは `handler_test.ts`。
  - `sharedAi` モード
  - 初回Topic生成: `NewsDetailController._getOrGenerateSharedChunk` のchunk 1 MISS → `AiService.requestSharedInitial` → [shared_router.ts](../supabase/functions/generate-ai-replies/shared_router.ts)。`ready`後は `ReplyCacheService.loadChunk` で取得。接続・quota設定契約: [SHARED_AI_ROUTER_API.md](SHARED_AI_ROUTER_API.md)。
  - 共有AIチャンク2以降の通常生成: Flutter `AiService.generateReplies` / `NewsDetailController._getOrGenerateSharedChunk` がURL・要求チャンク番号・会話パターンを送信 → [handler.ts](../supabase/functions/generate-ai-replies/handler.ts) → [parallel_router.ts](../supabase/functions/generate-ai-replies/parallel_router.ts)。旧Flutterのメタデータなし要求は従来経路を維持する。
  - Provider順位と並行条件: [normal_router.ts](../supabase/functions/generate-ai-replies/normal_router.ts) が維持するGroq → Cloudflare → Gemini 3.1 → OpenRouter。7秒前の確定失敗は次順位へ進む。7秒処理中なら通常通信を継続してGoogle Gemmaを1回並行起動する。全通常モデルが失敗・利用不可ならGemmaを試す。先着成功は要求チャンクへ保存、遅延成功はwaitUntil経由で次の空きチャンクへ保存する。
  - 保存・claim: [shared_ai_store.ts](../supabase/functions/generate-ai-replies/shared_ai_store.ts) が内部RPCを呼ぶ。[shared AI later chunk migration](../supabase/migrations/20260928144828_shared_ai_later_chunk_generation.sql) の `shared_ai_chunk_generations`、claim/complete/late-append/fail RPC、記事行ロック、生成ID冪等キー、既存 `append_shared_ai_chunk` の記事ID overloadを使用する。service_roleには[返信列権限migration](../supabase/migrations/20260928164328_grant_shared_chunk_replies_to_service_role.sql)による最小SELECT権限が必要。Flutterは `ReplyCacheService.loadChunk` で確定結果を読み、再保存しない。
  - 通常経路の期限: [generation_budget.ts](../supabase/functions/generate-ai-replies/generation_budget.ts) の40秒要求期限と累計5秒quota/cooldown予算を維持。通常Providerは7秒で中断せず個別上限30秒、Google Gemmaは6秒。遅延保存は元要求期限に接続し、waitUntilの実行完了は保証しない。
  - Provider共通設定・リクエスト変換: [shared_provider.ts](../supabase/functions/generate-ai-replies/shared_provider.ts)。`PROVIDERS`、`providerAvailable`、`providerRequest`。直接利用元は `shared_router.ts`、`normal_router.ts`、`parallel_router.ts`。モデルID・無料枠設定・認証・API形式を変更する場合は各経路に影響する。チャンク1の選択・並列処理・timeoutは `shared_router.ts` に残す。
  - 段階的rollout gate: [shared_router_rollout.ts](../supabase/functions/generate-ai-replies/shared_router_rollout.ts) と `AI_SHARED_ROUTER_ROLLOUT`。不正・未設定はfail closed、限定Topicのみ許可可能。確認: `handler_test.ts`。
  - 共通quota: [_shared/ai_rate_limit.ts](../supabase/functions/_shared/ai_rate_limit.ts)。Facts待機、Gemma Stage 2、Groq Stage 1とRedis使用量を共有。Cloudflare NeuronsとOpenRouter無料モデル枠はProvider専用の原子的予約。
  - ジョブ/試行/共通採番: [free_shared_ai_router migration](../supabase/migrations/20260927093027_free_shared_ai_router.sql) の初回ジョブ・試行・Topic向け `append_shared_ai_chunk` と、本機能の [後続チャンクclaim migration](../supabase/migrations/20260928144828_shared_ai_later_chunk_generation.sql)、[service_role返信列権限migration](../supabase/migrations/20260928164328_grant_shared_chunk_replies_to_service_role.sql)。
  - AI
    ProviderへのHTTP通信、APIキー、モデル指定、Provider向けプロンプト構築・設定はEdge側
- Model:

  - [ReplyItem / ReplyOrigin](../lib/models/reply_item.dart)
  - [ConversationPlan / ConversationPattern / ReplyRelation / CachedReplyChunk](../lib/models/conversation_pattern.dart)
- 主な状態:

  - Supabase `articles`
  - Supabase `thread_chunks`
  - Supabase `shared_ai_chunk_generations`（記事・要求チャンクのclaim状態、lease、会話パターン、冪等なlate save）
  - `_sharedReplies`
  - `_cachedQueue`
  - `_loadingChunks`
  - 通常生成要求の `GenerationBudget`、`quotaRemaining`、`NORMAL_MODEL_ORDER`、共通診断ID（永続状態ではない）
- 調査注意:

  - FlutterはAI Providerを直接呼ばず、`AiService` から `generate-ai-replies`
    へ構造化データを送る。
  - 新契約の `sharedAi` MISS経路は診断IDをHTTP headerとRPCへ渡し、Edge側の `[AiReplies]` / `[SharedAiChunkStore]` でProvider開始・HTTP status・検証・quota期限・先着/遅延保存・チャンク番号を追跡する。FlutterはSDK例外statusと診断IDを記録する。時間予算はチャンク1専用ルーターには適用しない。
  - `parallel_router.ts` は既存 `AiRateLimiter` の設定・原子的Lua予約・Redis scopeを維持し、要求専用累計5秒予算で予約と429 cooldownを実行する。チャンク1、Facts、Stage 1/2と無料枠を消費し合う。予約不明時は返金せず、期限後のquota結果でProviderを起動しない。quota本体の主要利用元への影響確認は `ai_rate_limit_test.ts`。`normal_router.ts` はメタデータなし旧クライアントの互換経路。
  - 通常経路は同一プロンプト・過去コンテキストを全Providerへ渡し、既存JSON補正と厳密な10件検証を使用する。通常投稿・特定AI住人への返信は `ai_replies.ts` のGemini 3.5 / 30秒経路。CURRENT_SPEC対応は12.1、12.2、14.1、14.1.1、14.4。初回専用ルーターは14.5。
  - `articles / thread_chunks` のHIT/MISS判定、保存結果の読取・`ReplyItem` 化、表示順はFlutter側。新契約の後続MISS生成・保存・採番はサーバー側。旧Flutterのメタデータなし要求は従来保存の互換経路を維持する。
  - localAi / user投稿をsharedAi保存・生成コンテキストへ混ぜない。
  - 31Bと初回ルーターは同じ `articles` / `thread_chunks` へ保存成功順で原子的に採番し、各10 replies、`independent`として既存sharedAi読取経路で利用する。後続チャンクのFlutter取得・生成経路は維持。
  - Provider固有のプロンプト・モデル・APIキーをFlutter側の調査対象としない。
- 関連テスト:

  - [conversation_pattern_test.dart](../test/conversation_pattern_test.dart)
  - [load_more_error_test.dart](../test/load_more_error_test.dart)
  - [shared_ai_error_message_test.dart](../test/shared_ai_error_message_test.dart)
  - [ai_replies_test.ts](../supabase/functions/generate-ai-replies/ai_replies_test.ts)（プロンプト・返信関係・JSON補正、通常投稿・特定AI住人への返信のGemini 3.5 / 30秒・fallbackなし）
  - [normal_router_test.ts](../supabase/functions/generate-ai-replies/normal_router_test.ts)（旧契約の通常順位・時間予算と共通Lua予約の回帰確認）
  - [parallel_router_test.ts](../supabase/functions/generate-ai-replies/parallel_router_test.ts)（先着通常結果、7秒後も通信継続、Gemma並行起動、Gemma先着時の後続保存）
  - [ai_service_test.dart](../test/ai_service_test.dart)（サーバー保存契約の要求フィールド）
  - [Cloudflare Topic Pregen tests](../cloudflare/topic-pregen/src/index_test.ts)
  - [shared_router_test.ts](../supabase/functions/generate-ai-replies/shared_router_test.ts)（共通Provider変更時の初回ルーター影響確認）、[handler_test.ts](../supabase/functions/generate-ai-replies/handler_test.ts)（認証・rollout allowlist・disabled legacy互換、期限時の502と診断ID・遅延成功不採用）
  - [ai_rate_limit_test.ts](../supabase/functions/_shared/ai_rate_limit_test.ts)（Lua実行、Facts優先、429、共通quota、Cloudflare Neurons、OpenRouter free pool）
  - [ai_quota_config_proposal_test.ts](../supabase/tests/ai_quota_config_proposal_test.ts)（保存済みAI_QUOTA_CONFIG案の全モデル・scope・Stage 1確認）
  - [shared_ai_router_test.ts](../supabase/tests/shared_ai_router_test.ts)（PGlite、初回router/31B互換、重複claim、旧Flutter保存割込み防止、主/遅延保存の採番・冪等性、service_roleの返信列権限回帰）
  - [shared_ai_router_pg_concurrency_test.ts](../supabase/tests/shared_ai_router_pg_concurrency_test.ts) と [run_shared_ai_router_pg_concurrency.ps1](../supabase/tests/run_shared_ai_router_pg_concurrency.ps1)（隔離PostgreSQL複数接続の競合テスト）

<a id="user-post"></a>

### user投稿

- 現行仕様: `CURRENT_SPEC` 15章「ユーザー投稿とlocalAi」。
- 調査開始:

  - [NewsDetailReplyInput](../lib/widgets/news_detail_reply_input.dart)
  - [InputLimitUtils](../lib/widgets/input_limit_utils.dart): 文字数制限
  - `NewsDetailPage._postComment`
  - `NewsDetailController.postComment`
- Logic:

  - [ReplySubmissionAnalysis](../lib/models/reply_submission_analysis.dart)
- Model:

  - `ReplyItem(type: user, origin: user)`
- Edge:

  - なし
- 主な状態:

  - Pageの `TextEditingController`
  - Controllerの `replies`
- 関連:

  - localAi返信
  - 投稿後ジャンプ
  - 投稿直後広告
- 調査注意:

  - user投稿は `articles / thread_chunks` の共有キャッシュ対象ではない。
  - 投稿受理処理とlocalAi生成完了処理を分けて追う。
  - 投稿位置・表示番号変更が原因候補の場合はアンカー番号変換まで確認する。
  - AI生成中の送信可否、入力内容保持、生成失敗後の再送状態も投稿経路として確認する。
- 関連テスト:

  - [reply_submission_analysis_test.dart](../test/reply_submission_analysis_test.dart)
  - [reply_input_state_test.dart](../test/reply_input_state_test.dart)

<a id="local-ai"></a>

### localAi返信

- 現行仕様: `CURRENT_SPEC` 14章「AI生成」、15章「ユーザー投稿とlocalAi」。
- 調査開始:

  - `NewsDetailController.postComment`
  - [ReplySubmissionAnalysis](../lib/models/reply_submission_analysis.dart) の
    `analyze / _isMeaningful`:
    先頭アンカー・本文・低情報投稿を解析し、`shouldGenerateAiReply`
    をControllerへ返す。
  - `NewsDetailController._generateLocalAiRepliesInBackground`
- Service:

  - [AiService](../lib/ai_service.dart)
  - `AiService.generateUserReplies`
  - `AiService.generateReplyToSpecificUser`
- Edge:

  - [generate-ai-replies](../supabase/functions/generate-ai-replies/index.ts)
  - [ai_replies.ts](../supabase/functions/generate-ai-replies/ai_replies.ts)
  - 通常投稿への返信は `userReply` モード
  - 特定AI住人への返信は `specificPersonReply` モード
  - AI
    ProviderへのHTTP通信、APIキー、モデル指定、Provider向けプロンプト構築・設定はEdge側
- Model:

  - `ReplyItem(origin: localAi)`
- 関連:

  - [low_information_words.dart](../lib/config/low_information_words.dart)
- 主な状態:

  - `replies`
  - `_generatingUserMessages`
- 調査注意:

  - FlutterはAI Providerを直接呼ばず、`AiService` から `generate-ai-replies`
    へ構造化データを送る。
  - localAiをsharedAi保存・sharedAi生成コンテキストへ混ぜない。
  - 特定AI住人への返信ではID継承処理も確認する。ID・人格・`replyTo`
    の管理はFlutter側。
  - `>>userレス` ではユーザーIDをAI住人へ継承しない。
  - localAi後挿入によって表示indexが変化するため、番号ずれ問題では広告・アンカー・共有番号変換まで追う。
  - `_sharedIndexToDisplayNumber`
    の再計算有無を確認せず番号修正を決め打ちしない。
  - 生成失敗・タイムアウト時は生成状態解除と再試行経路を確認する。
  - Provider固有のプロンプト・モデル・APIキーをFlutter側の調査対象としない。
- 関連テスト:

  - [load_more_error_test.dart](../test/load_more_error_test.dart)
  - [ai_replies_test.ts](../supabase/functions/generate-ai-replies/ai_replies_test.ts)

<a id="anchors"></a>

### >> アンカー

- 現行仕様: `CURRENT_SPEC` 15.3「`>>番号` 投稿」、16章「アンカージャンプ」。
- 調査開始:

  - [ReplyCard](../lib/widgets/reply_card.dart)
  - `ReplyCard.onAnchorTap`
  - `NewsDetailController.requestJump`
  - `NewsDetailPage._replyTo`
  - [ReplySubmissionAnalysis.analyze](../lib/models/reply_submission_analysis.dart):
    `referencedNumber / bodyForDisplay / bodyForCheck`
  - `NewsDetailController.postComment` → `findReferencedReply`
  - `_addRepliesToView`
- 共有キャッシュ:

  - `ReplyCacheService.saveChunk`
  - `ReplyCacheService.loadChunk`
  - `ReplyCacheService.loadReplies`
- Model:

  - `ReplyItem.replyTo`
  - `ReplyOrigin`
  - `ReplyRelation`
- 主な番号状態:

  - `replies` のindex + 1
  - `_sharedIndexToDisplayNumber`
  - DBチャンク内相対番号
- 調査注意:

  - sharedAi系列番号とuser/localAiを含む表示番号を混同しない。
  - user表示とAI表示でアンカー描画構造が異なる。
  - 投稿の構造化解析は `postComment` → `ReplySubmissionAnalysis.analyze`
    の先頭アンカー解析を中心に追う。
  - AIレス対象とuserレス対象でID継承ルールが異なる。
- 関連テスト:

  - [reply_card_test.dart](../test/reply_card_test.dart)
  - [reply_sheet_responsiveness_test.dart](../test/reply_sheet_responsiveness_test.dart)

<a id="post-jump"></a>

### 投稿後ジャンプ

- 現行仕様: `CURRENT_SPEC` 16章「アンカージャンプ」。
- 調査開始:

  - `NewsDetailController.postComment`
  - `NewsDetailController.requestJump`
  - [NewsDetailReplySheetState](../lib/widgets/news_detail_reply_sheet.dart)
  - `_onControllerChanged`
  - `_performJump`
- Service:

  - なし
- Model:

  - `ReplyItem`
- Edge:

  - なし
- 主な状態:

  - Controller `pendingJumpNumber`
  - Controller `pendingSourceNumber`
  - Controller `jumpSourceNumber`
  - Sheet `_itemKeys`
  - Sheet `_isProgrammaticJump`
  - Sheet `_scrollOperationCount`
- 調査注意:

  - 未build対象は概算位置へ移動し、フレーム後に `Scrollable.ensureVisible`
    で正確に合わせる。
  - 投稿ジャンプは戻り先なし。
  - アンカージャンプは元レスへ戻れる。
  - プログラムジャンプ中は追加読込を抑止する。
  - 自動ジャンプ完了後に手動操作なしで末尾補正が位置を変更していないか確認する。
- 関連テスト:

  - [reply_sheet_responsiveness_test.dart](../test/reply_sheet_responsiveness_test.dart)

<a id="scroll"></a>

### AI掲示板スクロール / Overscroll

- 現行仕様: `CURRENT_SPEC` 17章「AI掲示板の無限スクロール」。
- 調査開始:

  - [NewsDetailReplySheetState](../lib/widgets/news_detail_reply_sheet.dart)
  - `build`
  - `_scheduleScrollCorrection`
  - `_correctScrollPositionIfNecessary`
  - `NewsDetailController.loadMoreReplies`
  - `NewsDetailController.retryLoadMoreReplies`
- Service:

  - 読込は `ReplyCacheService / AiService`
  - 可視率計測は
    [AiChunkAnalyticsService](../lib/services/ai_chunk_analytics_service.dart)
- Model:

  - `ReplyItem`
  - `CachedReplyChunk`
  - `AiChunkEngagementEvent`
- Edge:

  - AI掲示板読込の直接Edge呼び出しなし
  - 分析はSupabase側保存経路を持つ
- 主な状態:

  - Sheetの `ScrollController`
  - `PageStorageKey('ai_replies_list')`
  - プログラムジャンプ・スクロール補正用状態
  - `loadMoreErrorMessage`
- 調査注意:

  - 下方向スクロールで末尾約200px以内、または直接ドラッグの下端Overscrollで追加読込する。
  - プログラムジャンプ中は追加読込を抑止する。
  - `itemBuilder` を取得トリガーと誤認しない。
  - 同一チャンクの重複取得防止を確認する。
  - 追加取得失敗では既存レスを残し、再試行UIまで確認する。
  - 補正は自動ジャンプ直後に不用意に発火させない。
- 関連テスト:

  - [load_more_error_test.dart](../test/load_more_error_test.dart)
  - [reply_sheet_responsiveness_test.dart](../test/reply_sheet_responsiveness_test.dart)

<a id="reply-reports"></a>

### レス操作 / user削除 / AIレス通報

- 現行仕様: `CURRENT_SPEC` 11.3〜11.4、13.4、20章。
- `ReplyOrigin.user` は返信 / コピー / 削除、`sharedAi` / `localAi`
  は通報対象として経路を分けて追う。
- user削除ではレス自体を除去・再採番せず、削除表示と保存記事の削除状態永続化を確認する。
- UI: [ReplyCard](../lib/widgets/reply_card.dart) の `_showActions` →
  [AiReplyReportSheet](../lib/widgets/ai_reply_report_sheet.dart)。接続は
  `NewsDetailReplySheet` → `NewsDetailReplyEntry`。
- 調査開始:
  - [AiReplyReportSheet](../lib/widgets/ai_reply_report_sheet.dart)
  - [InputLimitUtils](../lib/widgets/input_limit_utils.dart):
    補足コメント文字数制限
- 状態: [NewsDetailController](../lib/controllers/news_detail_controller.dart)
  の `reportReply` / `isReplyReported`。
- Model:
  [AiReplyReport](../lib/models/ai_reply_report.dart)、`ReplyItem.reportTargetId / canReport`。
- 識別子付与:
  `ReplyCacheService.loadChunk / loadReplies`、`NewsDetailController._getOrGenerateSharedChunk / _createAiReply`。`ReplyItem.copyWith`
  で保持し、`toJson` の共有キャッシュには含めない。
- 保存:
  [AiReplyReportService.save](../lib/services/ai_reply_report_service.dart) →
  Supabase RPC `save_ai_reply_report` → `ai_reply_reports`。
- DB定義:
  [20260905000000_add_ai_reply_reports.sql](../supabase/migrations/20260905000000_add_ai_reply_reports.sql)。実環境への適用状況は別途確認する。
- テスト:
  [ai_reply_report_test.dart](../test/ai_reply_report_test.dart)、[ai_reply_report_ui_test.dart](../test/ai_reply_report_ui_test.dart)、[ai_reply_report_service_test.dart](../test/ai_reply_report_service_test.dart)、`reply_card_test.dart`、`reply_sheet_responsiveness_test.dart`。

<a id="paging-ai"></a>

### AI掲示板表示 / レス・広告・生成状態

- 現行仕様: `CURRENT_SPEC`
  11章「AIレスデータ」、15章「ユーザー投稿とlocalAi」、17章「AI掲示板の無限スクロール」、18章「広告」。
- 調査開始:

  - [NewsDetailReplySheet](../lib/widgets/news_detail_reply_sheet.dart)
  - [NewsDetailReplyEntry](../lib/widgets/news_detail_reply_entry.dart)
  - [NewsDetailReplyBottom](../lib/widgets/news_detail_reply_bottom.dart)
  - [ReplyCard](../lib/widgets/reply_card.dart)
- 調査注意:

  - `NewsDetailReplySheet` がレス位置用GlobalKeyを管理する。
  - ReplyCard単体の問題か、Entryで付加される広告・生成状態の問題かを分けて確認する。
  - リスト末尾の読み込み・エラー・再試行表示は `NewsDetailReplyBottom`
    を優先して確認する。
  - 広告と生成中表示はレス番号に含めない。

<a id="ads"></a>

### AdMob / 広告

- 現行仕様: `CURRENT_SPEC` 18章「広告」。
- ニュース一覧調査開始:

  - [NewsHomeHome](../lib/widgets/news_home_home.dart)
  - [NewsHomePage](../lib/pages/news_home_page.dart)
  - [NewsBannerAd](../lib/widgets/news_banner_ad.dart):
    (撤去済み) 固定Banner表示コンポーネント。ニュース一覧からは撤去済み。
  - `NewsHomeHome._slot / _startTopAd / _disposeNativeSlots`:
    選択カテゴリのNative枠。
  - [NativeAdCard](../lib/widgets/native_ad_card.dart):
    viewport基準の先読み・侵入検出。
- AI掲示板調査開始:

  - [NewsDetailReplySheet](../lib/widgets/news_detail_reply_sheet.dart)
  - [ReplyAdPolicy](../lib/models/reply_ad_policy.dart)
  - `NewsDetailController`
  - [pr_card.dart](../lib/widgets/pr_card.dart): 広告の論理配置区分
    `AdPlacement` enumのみ。広告表示は `NativeAdCard` が担う。
  - `AdPlacement`
  - [ThreadAdSession](../lib/services/thread_ad_session.dart):
    ReplyAdPolicyへの接続、物理広告と論理機会の管理、置換・失敗・dispose。
- 既存の主な状態:

  - `ReplyAdPolicy._placements`
- AdMob V1の実装入口:

  - [AdConsentService](../lib/services/ad_consent_service.dart):
    UMPとSDK初期化。起動入口は `NewsHomePage.initState`。
  - [AdMobConfig](../lib/config/ad_mob_config.dart): 3用途の広告ID、build
    mode、予約高さ。
  - [NativeAdSlot](../lib/services/native_ad_slot.dart):
    1枠1インスタンス、ロード状態、SDKイベント、遅延コールバック破棄。
  - [AdIdentity](../lib/models/ad_identity.dart):
    物理ID、論理機会、AI生成・投稿との関連。
  - [SettingsPage](../lib/pages/settings_page.dart): UMP Privacy Options入口。
  - Android:
    [MainActivity](../android/app/src/main/kotlin/com/aisoku/app/MainActivity.kt)
    → `NewsNativeAdFactory` / `ThreadNativeAdFactory`。共通asset補助は
    [NativeAdAssets.kt](../android/app/src/main/kotlin/com/aisoku/app/NativeAdAssets.kt)。
  - [MonetizationAnalyticsService](../lib/services/monetization_analytics_service.dart):
    永続outbox → `record_monetization_events` RPC。
  - [migration](../supabase/migrations/20260905190052_add_monetization_events.sql):
    `monetization_events`、`ad_instance_metrics`、`ai_generation_metrics`。実環境へ未適用。
  - AI実リクエスト計測は `AiService._postToEdge`。Controllerの
    `_sharedGenerationIds` / `contributionId` を `ThreadAdSession` へ接続。
  - [導入設定・集計例](ADMOB_V1_SETUP.md)。

- 確認する責務:

  - Google Mobile Ads SDK初期化とUMP同意フロー
  - Debug / ReleaseのAd Unit ID切替と設定集約
  - ニュース固定Anchored Adaptive Banner（撤去済み）
  - ニュースNative広告のカテゴリ先頭 / 10件間隔スロット管理
  - ニュースNative広告の約1画面手前ロード、予約領域、失敗状態、カテゴリ離脱dispose
  - ニュース一覧用NativeAdFactory（120×120dp以上のMediaViewを含む）
  - AI掲示板用NativeAdFactory（テキスト主体）
  - 掲示板広告の `hasEnteredViewport` 等による置換保護
  - 1広告枠1インスタンス、ロード失敗時処理、dispose
  - 設定画面の「プライバシー設定」入口
  - 広告イベント / AIコスト関連付け用の計測・保存経路
- AdMob V1で扱う論理区分:

  - Ad Unit: `news_banner` / `news_native` / `thread_native`
  - placement: `fixedBanner` / `newsTop` / `newsInterval` / `normalComment` /
    `postContribution`
  - 識別子: `adInstanceId` / `adOpportunityId` / `threadAdSequence` /
    `generationId` / `contributionId`
- Edge:

  - 広告表示自体の直接Edge呼び出しなし。
  - 広告・AI計測はSupabase RPC `record_monetization_events`。Edge
    Function追加なし。
- 調査注意:

  - 広告位置を `ReplyItem` 自体のデータと混同しない。
  - AI掲示板の配置判断は `ReplyAdPolicy`
    を正とし、AdMob導入時に配置ロジックを重複実装しない。
  - `normalComment` → `postContribution` の置換可否はSDK
    impressionではなく、広告Widgetのviewport侵入状態を確認する。
  - localAi後挿入による広告indexシフト問題はlocalAi項目も確認する。
  - ニュース一覧広告とAI掲示板広告は別経路として追う。
  - ニュースNativeのロード成功後挿入ではなく、事前予約領域を前提に確認する。
  - ニュースNativeはカテゴリ離脱でdispose、掲示板Nativeは画面外へ出ただけではdisposeしない。
  - UMPの `canRequestAds()` 前に広告ロードを開始しない。
  - `ad_impression` と `ad_paid` を同じ意味として扱わない。
  - SDKロード中の画面離脱では表示を直ちに無効化し、遅延完了で生じるNativeオブジェクトも破棄する。
- 関連テスト:

  - [reply_ad_policy_test.dart](../test/reply_ad_policy_test.dart):
    既存配置判定。
  - [ad_lifecycle_test.dart](../test/ad_lifecycle_test.dart):
    ロード競合、失敗、破棄、置換保護、関連ID、paid重複。
  - [ad_consent_test.dart](../test/ad_consent_test.dart)、[news_banner_ad_test.dart](../test/news_banner_ad_test.dart)、[news_native_ads_test.dart](../test/news_native_ads_test.dart)、[monetization_analytics_test.dart](../test/monetization_analytics_test.dart)。

<a id="topic-foundation"></a>

### Topic V1基盤

- Upstash Topic Vector移行: `supabase/functions/_shared/topic/upstash_vector.ts`、`topic-processing/index.ts`、`supabase/migrations/20260926083327_add_topic_upstash_vector_outbox.sql`
- 専用namespace `topic-openai-v1`。移行中はGemini RPCを検索元として維持し、normal Topicのinsert/updateをDB OutboxでUpstashへ反映する。初期backfillは直近24時間のGeminiベクトル保持Topicを対象にし、検索先切替前にOutbox残数0を確認する。
- `topic_vector_outbox_status`、`enqueue_recent_topic_vectors`、`sync_topic_vector_outbox` はworker secretで認証される運用action。再EmbeddingとUpstash書込みは明示的な運用action時のみ。
- 関連テスト: `_shared/topic/upstash_vector_test.ts`。
- 2026-09-26本番処理記録: Upstash Vector `topic-openai-v1` を検索先として稼働（topic-processing v34）。初回backfill 71件と差分3件を同期し、Geminiベクトルは保持。現行の運用状態はOperationsの読み取り値で確認する。

- Migration:
  `supabase/migrations/20260911054932_add_topic_processing_foundation.sql`
- Tables:
  `topics`、`topic_articles`、`topic_processing_logs`、`topic_processing_queue`
- Queue RPC: `enqueue_topic_article`、`claim_topic_processing_articles`
- NewsData batch enqueue RPC: `enqueue_topic_articles(text[])`
- New article enqueue:
  `supabase/functions/_shared/newsdata/topic_enqueue.ts`。Upstash新規保存成功IDだけを最大10件単位でenqueueし、失敗はNewsData
  jobを停止しない。
- Embedding/vector、Gemma、Edge Function本体は別Stepで実装する。

### Topic V1 Embedding基盤

- Migration: `supabase/migrations/20260911055318_enable_vector_extension.sql`
- Migration: `supabase/migrations/20260911055449_add_topic_embeddings_384.sql`
- Storage: `topic_embeddings_384`（`extensions.halfvec(384)`）
- Similarity RPC: `match_recent_topics_384`
- lookback、candidate limit、embedding versionはRPC引数で指定する。

### Topic worker

- Service role権限の補正:
  `supabase/migrations/20260923052408_harden_topic_function_grants.sql`（commit
  RPCの公開EXECUTEを撤回し、thread title内部テーブルをworker専用にする）
- Thread title内部テーブルのpublic role権限撤回:
  `supabase/migrations/20260923110222_revoke_public_thread_title_table_privileges.sql`（anon/authenticatedからTRUNCATE等を撤回）
- Edge Function: `supabase/functions/topic-processing/index.ts`
- Worker auth: `x-topic-processing-secret` via `TOPIC_PROCESSING_SECRET`;
  gateway JWT verification is disabled for this worker.
- Queue claim: `claim_topic_processing_articles`
- Stage 2 retry/defer: `supabase/functions/_shared/topic/gemma.ts` retries only HTTP 500 / 502 / 503 / 504, and uses existing queue `available_at` plus `stage2_attempt_count` for bounded 429 / long `Retry-After` resumption. Queue mutation uses a claim-id/count compare-and-set in `queue.ts`; `claim_topic_processing_articles` skips rows until their scheduled time. No new queue or Cron is added.
- Stage 2 retry quota: `_shared/ai_rate_limit.ts`; every outbound retry uses `quotaFetch`, and a read-only quota inspection contributes the queue resume time.
- Stage 2 retry observability: `_shared/topic/log.ts` reuses `topic_observability_logs`; Operations Dashboard shows initial HTTP status, retry count, final result/status, quota stop and the next queue time.
- Stage 2 retry migration: `supabase/migrations/20260929114948_add_topic_stage2_defer_state.sql`.
- Retry / shared-path impact tests: `gemma_test.ts`, `queue_test.ts`, `quota_test.ts`, `stage1_test.ts`, `gemma_parser_test.ts`, `log_test.ts`, `thread_title_test.ts`, `article_body_test.ts`, `ai_rate_limit_test.ts`; Operations Dashboard `server.test.js` / `app.test.js`, `generate-ai-replies/ai_replies_test.ts`, and `cloudflare/topic-pregen/src/index_test.ts`.
- Article load: `supabase/functions/_shared/topic/article_store.ts`
- Article body fetch / Readability extraction:
  supabase/functions/_shared/topic/article_body.ts (called after article
  pre-filter and before Stage 1; failure terminalizes only the article).
- Comment-dominated body filter:
  `supabase/functions/_shared/topic/comment_structure_filter.ts` detects
  repeated numbered post headers after successful Readability extraction and
  before Stage 1; excluded articles terminalize before Stage 1 / Stage 2 /
  Embedding / Topic creation. It reuses `excluded` processing logs with
  `comment_structure` stage and count-only diagnostics; no schema change.
- Comment structure tests:
  `supabase/functions/_shared/topic/comment_structure_filter_test.ts` reads
  saved Model Benchmark article bodies read-only; exclusion log safety is
  covered by `log_test.ts`.
- Facts Stage 2 receives cleaned body via TopicArticle.cleaned_body:
  supabase/functions/_shared/topic/gemma.ts.
- Article body fixture tests:
  supabase/functions/_shared/topic/article_body_test.ts; Gemma Facts input test:
- `article_body.ts`はHTTP error / timeout / fetch failure / DOM解析失敗 / Readability失敗 / 本文0文字を分類する。一時通信失敗とHTTP 429/5xxだけ1回再試行（12秒timeout、500ms間隔）。本文取得の最終失敗記事はStage 1 / Stage 2へ送らず終端除外する。成功・失敗、Readability方式、本文文字数、所要時間、redirectを`topic_observability_logs`へ記録し、本文自体は保存しない（7日保持）。description欠損記事はStage 1のdescription欄だけ本文で補完し、Stage 2ではdescriptionをnullのままcleaned bodyを別入力として渡す。関連回帰テスト: `article_body_test.ts`、`queue_test.ts`、`stage1_test.ts`、`gemma_test.ts`、`log_test.ts`。
  supabase/functions/_shared/topic/gemma_test.ts; safe log preview test:
  supabase/functions/_shared/topic/log_test.ts.
- Worker config/auth: `supabase/functions/_shared/topic/config.ts`
  共通quotaとFacts待機優先: `supabase/functions/_shared/ai_rate_limit.ts`、`topic-processing/index.ts`。影響確認: `ai_rate_limit_test.ts`、`stage1_test.ts`、`gemma_test.ts`。31B retryは従来どおりRedisを使用しない。
- Processing log helper: `supabase/functions/_shared/topic/log.ts`
- Stage 1 Groq client: `supabase/functions/_shared/topic/stage1.ts`（JST時間帯別Qwen 3.8 27B / GPT-OSS 20B、timeout retry、fallback）。Parser/validation: `gemma_parser.ts`（`category` 判定、`subject` / `event` 検証）
- Stage 2 Gemma facts client: `supabase/functions/_shared/topic/gemma.ts`（facts抽出、thread titleとは分離）
- Stage 1 tests: `supabase/functions/_shared/topic/stage1_test.ts`; Stage 2 tests: `supabase/functions/_shared/topic/gemma_test.ts`, `queue_test.ts`, `_shared/ai_rate_limit_test.ts`, and `log_test.ts`. Dashboard impacts: `tools/operations-dashboard/server.test.js` and `app.test.js`.
- Thread title batch: `supabase/functions/_shared/topic/thread_title.ts`,
  `thread_title_queue.ts`（Gemini 3.5 Flash-Lite、Prompt C、Thinking Medium、
  4 Topic固定batch、PT quota/Probe）。HTTP 503だけ最大1回retryし、Retry-After
  （最大60秒）とPT quota/要求間隔をRPCで原子的に予約する。明示した過去48時間以内
  内にある503失敗はタイトル未生成の完全4件batchのみ一度だけ再キュー可能。
  文字数超過監査は既存
  `topic_thread_title_batches.failure_types` を使用し、DB title制約緩和は
  `20260926182105_allow_overlength_thread_titles.sql`。影響確認: `thread_title_test.ts`、`20260929001905_add_thread_title_retry_and_body_observability.sql`、`20260929002338_bound_thread_title_503_recovery_window.sql`、`20260929002523_extend_thread_title_recovery_window.sql`。
- 新規Topic通知: thread title確定後に `thread_title_queue.ts` が
  `get_topic_pregen_inputs` RPCで最新成功Topicを1件取得し、専用Cloudflare
  endpointへのbest-effort通知完了を待つ。認証済み `topic-processing` の
  `notify_topic_pregen_once` 操作で、title確定済み・pregen
  pendingの既存Topicを1件だけ通知できる。`topic_pregen_pending`
  は新規insertだけが候補になり、mergeでは再設定しない。
- 31B保存・最新target世代:
  `supabase/migrations/20260924120000_add_topic_pregen_cache.sql` の
  `topic_pregen_target`、`register_topic_pregen_target`、`save_topic_pregen_chunk`。`20260927093027_free_shared_ai_router.sql` で保存RPCを共通appendへ接続し、最新generation検査を維持したまま後着結果も次チャンクへ保存する。
- Cloudflare Worker / SQLite-backed singleton Durable Object / Alarm:
  `cloudflare/topic-pregen/`。Google
  31B呼出、HTTPエラーmessageの安全化診断保存、attempt制限、cooldown、最新target制御を行い、retry中Supabase/Upstashへアクセスしない。
- Operations monitor: `tools/operations-dashboard/server.js` の
  `/api/topic-pregen` が`.env.server`のWorker URL / 診断Secretをサーバー側で読み、手動更新時だけ認証付き `GET /internal/status` を行い、安全化済みAPIエラーメッセージを含む許可項目だけをブラウザーへ返す。SecretやWorker応答全体はブラウザーへ返さない。
- Gemini Embedding client:
  `supabase/functions/_shared/topic/embedding.ts`（`gemini-embedding-2`、384次元、`embedding_version`）
- Upstash Vector client:
  `supabase/functions/_shared/topic/upstash_vector.ts`（`openai/text-embedding-3-small`、1536次元、`topic-openai-v1`、Outbox差分同期）
- Topic workerはStage 1成功かつ`除外`でない記事をStage 2 / Embeddingへ渡す。
- Topic commit RPC:
  `commit_new_topic_384`、`commit_topic_merge`、`finalize_topic_excluded`（Topic
  facts集約・掲載基準判定）
- Vector search worker:
  `supabase/functions/_shared/topic/topic_store.ts`（24時間、candidate 1、worker
  threshold 0.88）
- Topic作成・Embedding保存、既存Topic
  merge、Gemma/Embedding/Vector失敗singletonをRPC transactionで確定する。
- Topic category classification and NewsData fallback fields:
  `topic-processing/index.ts`
- External API start guard: `markExternalApiStarted` in
  `supabase/functions/_shared/topic/queue.ts`
- Worker auth tests: `supabase/functions/_shared/topic/config_test.ts`; related
  worker tests: `queue_test.ts`, `quota_test.ts`, `gemma_parser_test.ts`,
  `gemma_test.ts`, `embedding_test.ts`, `topic_store_test.ts`,
  `thread_title_test.ts`, `log_test.ts`,
  `cloudflare/topic-pregen/src/index_test.ts`

### Topicカードのソース取得

- Flutter:
  `lib/services/topic_source_service.dart`、`lib/widgets/topic_source_sheet.dart`、`NewsHomePage._onTopicLongPress`
- Edge Function: `supabase/functions/get-topic-sources/index.ts`
- 認証: Supabase AuthなしのFlutter直呼びに合わせ、Function内で
  `@supabase/server` の `auth: "publishable"` を検証する。deploy時は
  `verify_jwt=false`。CORS preflightのみ認証対象外。
- Public Topic確認: `topics` の公開条件（`thread_title_pending = false`、`facts`
  1件以上、`representative_published_at`あり）
- Article load: `topic_articles` の全 `article_id` → `source_store.ts`
  の1回のMGET
- Upstash:
  `newsdata:article:<canonical-id>`。TTL切れ・不正値は除外し、取得可能記事だけ返す。
- Test: `supabase/functions/get-topic-sources/handler_test.ts`（認証、CORS
  preflight、topic
  ID検証）、`supabase/functions/_shared/topic/source_store_test.ts`

<a id="database"></a>

### Supabase articles / thread_chunks

- 現行仕様: `CURRENT_SPEC` 13章「Supabase AI共有キャッシュ」。
- 初回ルーター共通保存: `supabase/migrations/20260927093027_free_shared_ai_router.sql`。article行ロック、試行一意キー、31B世代確認後の共通append、既存Flutter INSERTとの直列化trigger。テスト: `supabase/tests/shared_ai_router_test.ts`、`reply_cache_service_test.dart`。
- 31B事前生成 migration/RPC:
  `supabase/migrations/20260924120000_add_topic_pregen_cache.sql`
  (`topic_pregen_pending`, `topic_pregen_target`, `get_topic_pregen_inputs`,
  `register_topic_pregen_target`, `save_topic_pregen_chunk`)
- 調査開始:

  - [ReplyCacheService](../lib/reply_cache_service.dart)
  - `saveChunk`
  - `loadChunk`
  - `loadReplies`
  - `updateLastAccessedAt`
- 呼び出し元:

  - `NewsDetailController`
- Model:

  - `ReplyItem`
  - `CachedReplyChunk`
  - `ConversationPlan`
- 主な保存先:

  - Supabase `articles`
  - Supabase `thread_chunks`
  - [20260923060000_create_shared_ai_reply_cache.sql](../supabase/migrations/20260923060000_create_shared_ai_reply_cache.sql)
- Supabase接続: [main.dart](../lib/main.dart) は `.env` の `SUPABASE_URL` と
  `SUPABASE_PUBLISHABLE_KEY` を使用する。Flutter assetへ `service_role`
  keyを含めない。
- Edge:

  - なし
- 調査注意:

  - user/localAiはController側で共有保存対象外。
  - DB上の `replyTo` と画面上の表示番号を混同しない。
  - `ignoreDuplicates: true` 等の競合時処理を確認する。
  - 古いキャッシュ互換処理と現在生成する `ConversationPlan` を混同しない。
  - RLSは有効（FORCEなし）。Flutterのpublishable
    keyから直接アクセスし、anon/authenticatedにはarticlesのSELECT/必要列INSERT・UPDATE、thread_chunksの必要列SELECT/INSERTだけを許可する。DELETEは許可しない。
  - `saveChunk` は既存articlesを許可済みカラムだけUPDATEし、未作成ならINSERTする。並行INSERTのunique conflictでは既存articleを1回SELECTして再利用する。thread_chunksは `ignoreDuplicates: true` のUPSERTで保存する。
  - thread_chunks.article_idはarticles.idを参照し、ON DELETE
    CASCADE。ユーザー定義Triggerはない。
  - Cron、保持期限はこのキャッシュ機能にない。
- 分析機能を変更する場合のみ:

  - [20260904060000_add_ai_conversation_analytics.sql](../supabase/migrations/20260904060000_add_ai_conversation_analytics.sql)
  - [AiChunkAnalyticsService](../lib/services/ai_chunk_analytics_service.dart)
  - `recordVisibleReplies`
  - `recordAnchorTap`

AI閲覧・アンカータップ分析は、分析機能を変更する場合だけ追加調査する。CURRENT_SPECの主要ユーザー動作仕様とは分離して扱う。

<a id="saved"></a>

### 保存ニュース

- 現行仕様: `CURRENT_SPEC` 19章「保存ニュース」。
- 調査開始:

  - `NewsCard.onSave`
  - `NewsHomeController.toggleSaved`
  - [NewsHomeSaved](../lib/widgets/news_home_saved.dart)
  - [SavedThreadService](../lib/services/saved_thread_service.dart)
  - `NewsDetailController._restoreSavedArchive / _persistArchive`
  - 保存記事でサーバー処理が必要になる経路の生存確認 / read-only移行処理
  - [ReplyCacheService](../lib/reply_cache_service.dart): `articles` /
    `thread_chunks` の明示的不存在と一時障害の判定
- Model:

  - `NewsItem`
- 主な状態:

  - SharedPreferences `saved_news_urls`
  - SharedPreferences `saved_news_archives_v1`
  - Controller `savedUrls`
  - Controller `allNews` (非表示フィルタの影響を受けない全データ経路)
- Edge:

  - なし
- 調査注意:

  - `saved_news_urls` は保存対象の索引、`saved_news_archives_v1`
    は記事情報と読込済みスレッドの保存先。
  - 保存一覧の表示データと保存URL索引、ローカルスレッドアーカイブを混同しない。
  - RSS削除と保存URL削除は別処理として追う。
  - サイト非表示設定は保存ニュースには適用しない。
  - 保存記事を開いただけではサーバー生存確認を行わず、次sharedAi取得や投稿などサーバー処理が必要な時だけ確認する。
  - 明示的な不存在だけをread-only移行条件とし、timeout・通信不能・5xx相当を恒久終了扱いにしない。
  - read-onlyでも保存済みsharedAi / user / localAi /
    アンカーと元記事導線は維持し、新規投稿・新規生成は停止する。

<a id="hidden-sites"></a>

### サイト非表示

- 現行仕様: `CURRENT_SPEC` 6.8「サイト非表示」。
- 調査開始:

  - [NewsHomePage](../lib/pages/news_home_page.dart)
  - `_onNewsLongPress` (BottomSheet入口)
  - `_hideSite` (Snackbar表示・Undo・Timer制御)
  - [NewsHomeController](../lib/pages/news_home_controller.dart)
  - `hideSite` / `undoHideSite`
  - `hiddenHosts`
  - `reloadHiddenSites`
  - [HiddenSitesService](../lib/services/hidden_sites_service.dart)
  - `normalizeHost` (正規化: 小文字化, `www.` 除去)
  - `hide` / `unhide` / `getHiddenSiteNames` (永続化)
- 管理画面:

  - [SettingsPage](../lib/pages/settings_page.dart)
  - [HiddenSitesManagementPage](../lib/pages/hidden_sites_management_page.dart)
- UI関連:

  - [NewsCard](../lib/widgets/news_card.dart): `onLongPress` 検知
  - [NewsHomeHome](../lib/widgets/news_home_home.dart) /
    [NewsHomeSaved](../lib/widgets/news_home_saved.dart): コールバック伝播
- 調査注意:

  - 非表示フィルタは運営5カテゴリの一覧（`_applyFilteredNews`）にのみ適用する。
  - `RSS` タブおよび保存ニュース（`allNews` 経由）には適用しない。
  - Snackbarは明示的な `Timer`
    で3秒後に自動消去する。連続操作時は古いタイマーとSnackbarを破棄する。
  - RSS登録メニューは実装済み。`NewsHomePage._exploreRss` → `RssDiscoverySheet`
    →
    `RssDiscoveryService.discover`（`discover-rss-feed`）で探索し、候補の登録は
    `NewsHomeController.addFeed` →
    `NewsCacheService.ensureRssFeedExists`（`ensure-rss-feed`）を再利用する。詳細は「RSS追加・削除」を参照。
- 関連テスト:

  - [hidden_sites_test.dart](../test/hidden_sites_test.dart)

<a id="theme-settings"></a>

### 外観（テーマ）設定

- 現行仕様: `CURRENT_SPEC` 21章「外観（テーマ）設定」。
- 調査開始:

  - [ThemeService](../lib/services/theme_service.dart)
  - `ThemeService.init`
  - `ThemeService.setThemeMode`
  - [SettingsPage](../lib/pages/settings_page.dart) の `_showThemeDialog`
  - [main.dart](../lib/main.dart) の `NewsApp`
- 主な状態:

  - SharedPreferences `theme_mode` (`'system'`, `'light'`, `'dark'`)
  - `ThemeService.themeMode`
- 調査注意:

  - テーマ切り替え時に画面遷移、ニュース再取得、スクロール位置や入力内容の初期化を発生させない。
- 関連テスト:

  - [theme_service_test.dart](../test/theme_service_test.dart)


### ローカル Model Benchmark

- UI / API: `tools/model_benchmark/src/server.mjs`、`web/index.html`
- Prompt構築・Provider呼び出し・結果保存: `src/benchmark-core.mjs`
- 記事: `dataset/articles.csv`、`dataset/articles/*.json`。初期23記事と過去結果を保持し、新規収集分は記事JSONとCSVへ追加する。
- 本文抽出後、品質確認を通過した本文のみ記事JSONへ保存する。Benchmarkは保存済み本文を入力に使う。
- factsは記事・モデルごとに `results/facts/<article_id>/*.json` へ保存し、モデルID、APIモデル、Prompt snapshot / hash、生成条件、成功・失敗、factsを保持する。
- コメント生成は選択した保存済みfactsを入力し、共通facts方式とモデル別facts方式を切り替える。コメント結果にも入力factsと参照元を記録する。
- BenchmarkのNewsData記事収集は全体30件を目標にし、カテゴリ別件数は固定しない。検索は最大5回、記事ページ要求はリダイレクト込みで最大50回。300文字以上・抽出成功・本文多様性を満たし、重複や広告・関連記事過多でない記事を合格時点で保存する。不採用理由を実行別 `results/collection-runs/` に記録し、旧 `dataset/latest-collection-usage.json` は履歴として保持する。追加検索は自動実行しない。
- 保存処理: `src/collection-store.mjs`。関連テスト: `tests/benchmark-core.test.mjs`、`tests/collection-store.test.mjs`
