**\# AIニュース掲示板 \`news_app\` 現行仕様**

資料基準日: 2026-09-14

**\## 1. 文書の役割**

本書は、現在のアプリがどう動くべきかを示す現行仕様書である。

\* 変更履歴、廃止理由、検証ログ、将来案は記載しない。

\* 実装変更時は、旧仕様を追記せず該当記述を置き換える。

\* コードの担当箇所は \`docs/FEATURE_MAP.md\` で管理する。

\*
本書と実装または最新の確定仕様が食い違う場合は、推測で統合せず差異を確認する。

**\## 2. プロジェクト概要**

\* プロジェクト名: \`news_app\`

\* アプリ表示名: \`AI速\`

\* UIコンセプト: AIニュース掲示板

\* AndroidアプリID: \`com.aisoku.app\`

\* 対象: Flutter製Androidアプリ

ニュースを読み、AI速内の5ちゃんねる風AI掲示板を中心に楽しみ、必要なときだけ元記事を外部ブラウザUIで参照できることを基本体験とする。

利用者はニュース一覧の閲覧、RSSの追加・削除、記事の保存、AIレスの閲覧、自分の投稿、\`\>\>番号\`
による返信を行える。

**\### 2.1 Androidアプリアイコン**

Androidアプリアイコンは「AI速」のブランドデザインを使用する。

基本デザイン:

\* 青系背景

\* 白い \`AI\` ロゴ

\* AIから出る白い吹き出し

\* 吹き出し内に青い \`NEWS\`

元画像は次を基準とする。

\`\`\`text

assets/icon/aisoku_icon.png

\`\`\`

AndroidではAdaptive Iconを使用する。

\* Foregroundの \`AI\` と \`NEWS\`
は、円形・角丸等のランチャーマスクでも欠けないSafe Zone内へ収める。

\* 背景は青系ブランドカラーとする。

\* Legacy IconとRound Iconにも対応する。

\*
ランチャーマスクでロゴが切れる場合は、デザインそのものを変更せずForegroundの縮小・余白確保で対応する。

**\## 3. 全体の責務分離**

**\### 3.1 Flutterアプリ**

\* 画面表示と操作

\* RSSの個人設定

\* ニュース一覧の状態管理

\* AI掲示板を中心としたニュース詳細画面の表示

\* Partial Custom Tabによる元記事表示

\* AIレスの表示順、番号、名前、ID、返信関係

\* ユーザー固有の投稿とAI返信

\* 広告枠の表示位置

\* UMPの同意状態に基づく広告要求制御

\* 広告・AI生成関連の計測イベント生成

**\### 3.2 Upstash Redis**

\* RSS共有マスター \* 運営プリセット \* 最近利用されたユーザーRSS \*
RSSメタ情報 \* RSS単位のニュースキャッシュ \*
NewsData.io取得記事キャッシュ \*
NewsData.io取得スケジューラ状態、取得ジョブ・request・統計情報

Topic統合用のtopic、article-topic紐付け、Embedding、Topic処理ログはUpstashへ新設せずSupabaseで管理する。

**\### 3.3 Supabase**

\* AI掲示板の共有キャッシュである \`articles\` / \`thread_chunks\` \*
AI生成レス通報データ \`ai_reply_reports\` \*
広告・AI生成関連の計測データ \* Edge Functionsの実行基盤 \*
CronによるRSS巡回 \* NewsData.io記事のTopic統合データ \*
article-topic紐付け \* Topic検索用Embedding \* Topic処理結果・失敗ログ

ニュース一覧の共有キャッシュをSupabase DBへ保存しない。

**\### 3.4 AI API**

AI生成の通信経路は `Flutter -> Supabase Edge Function -> AI Provider`
とし、FlutterアプリからAI Provider APIを直接呼び出さない。

\* ニュース情報に基づくレス本文の生成

\* ユーザー投稿に対する返信本文の生成

\* AI
ProviderのAPIキー、モデル選択、プロンプト構築、Provider固有設定はSupabase
Edge Function側で管理する。

\* Edge
Functionは生成モード、入力サイズ、生成件数等の入力値を検証し、Flutterから渡された値を無条件に信用しない。

\* AI
Providerの生エラー、認証情報、その他の秘密情報をFlutterへ返さない。

レス番号、名前、ID、\`replyTo\`、\`ConversationPlan\`、広告、キャッシュ状態、表示順はAI
ProviderおよびEdge Functionに管理させず、Flutter側で管理する。

AI生成のサーバー側責務は、将来のレート制限、利用量制限、Hard
Limit、Emergency Stop等のコスト・不正利用制御を追加できる境界とする。

**\## 4. ニュースカテゴリ**

運営カテゴリは次の5つとする。

1\. トレンド

2\. エンタメ

3\. サブカル

4\. マネー

5\. IT・ガジェット

ユーザーRSS用の独立タブとして末尾に `RSS` を表示する。

スポーツ記事は `エンタメ` へ統合する。

**\### 4.1 運営ニュースのAIカテゴリ分類**

NewsData.ioが返す公式カテゴリは元データとして保持する。

運営ニュースの表示カテゴリは、Topic前処理時にGemma 4
26Bで記事ごとに再分類する。
Gemmaが返せるカテゴリは自由記述とせず、次の6種類に固定する。

\* トレンド \* エンタメ \* サブカル \* マネー \* IT・ガジェット \* 除外

-   `トレンド`、`エンタメ`、`サブカル`、`マネー`、`IT・ガジェット`
    の5種類を運営ニュースの表示カテゴリとして使用する。
-   `除外`
    と判定された記事は運営ニュースへ掲載せず、Topicを作成せず、Embedding処理にも進めない。
-   `除外`
    記事の元記事データは既存のNewsData.io記事キャッシュに残してよい。
-   `除外` 判定はTopic処理ログへ記録し、件数を後から集計可能にする。
-   Gemma処理そのものが失敗した場合は、既存のNewsData.io公式カテゴリからAI速5カテゴリへ対応付ける既存ルールをフォールバックとして使用する。フォールバック専用の新しい分類ロジックは作らない。
-   NewsData.ioの公式カテゴリは失わず、Gemma分類結果とは別に保持する。
-   Gemmaによる正常分類結果は1記事につき1つの表示カテゴリとする。

Gemma失敗時の既存フォールバック対応は次を使用する。

-   トレンド: `top`, `world`, `politics`, `crime`, `domestic`,
    `environment`, `education`, `health`, `tourism`
-   エンタメ: `entertainment`, `sports`, `lifestyle`, `food`
-   サブカル: `other`
-   マネー: `business`
-   IT・ガジェット: `technology`, `science`

NewsData.ioの記事に複数の公式カテゴリが付与され、Gemma分類に失敗した場合は、既存仕様どおり対応する複数の運営カテゴリへ表示できる。

Gemma分類に成功した場合はGemmaの1分類を優先し、NewsData.io公式カテゴリによる複数カテゴリ表示は行わない。

**\## 5. カテゴリタブ**

**\### 5.1 表示と操作**

\* タブ列は横スクロール可能とする。

\* 左側に隠れたタブがある場合だけ `‹` を表示する。

\* 右側に隠れたタブがある場合だけ `›` を表示する。

\* 全タブが画面内に収まる場合は両矢印を表示しない。

\*
矢印タップではカテゴリを選択せず、タブ列だけを120px、300msでスクロールする。

\* 指による横スクロールでも矢印状態を更新する。

\*
カテゴリタップ時は選択タブを必要な範囲だけ自動的に可視位置へ移動する。

**\### 5.2 選択カテゴリの保存と復元**

\* 最後にユーザーが選択したカテゴリ名を `SharedPreferences` に保存する。

\* 保存キーは `last_selected_news_category` とする。

\* インデックス番号は保存しない。

\* 起動時は `SharedPreferences` から保存カテゴリ名を読み込む。

\* 現在の運営カテゴリと `RSS` タブからカテゴリ一覧を構築する。

\*
カテゴリ一覧構築後、保存カテゴリ名が現在のカテゴリ一覧に存在するか確認し、現在の選択indexへ適用する。

\* 保存カテゴリが存在しなければ先頭カテゴリへフォールバックする。

\*
復元されたタブが画面外にある場合は、初期レイアウト後に即時位置合わせして可視化する。

保存カテゴリ名の読み込みと、現在のカテゴリ一覧に対する選択indexの適用は別処理として扱う。

**\### 5.3 カテゴリごとの一覧状態**

\* カテゴリごとのニュース一覧スクロール位置を独立して保持する。

\*
カテゴリを切り替えて戻った場合も、セッション中の表示件数とスクロール位置を維持する。

\* カテゴリ切替だけを理由にNewsData.io APIまたはRSS配信元へ通信しない。

**\### 5.4 カテゴリタブの並べ替え**

\* 運営カテゴリのタブは、ユーザーが長押しして左右へドラッグすることで並べ替え可能とする。

\* 並べ替え対象は `トレンド`、`エンタメ`、`サブカル`、`マネー`、`IT・ガジェット` の5カテゴリとする。

\* `RSS` は独立タブとして常に末尾に固定し、並べ替え対象に含めない。

\* 並べ替え後の運営カテゴリ順を `SharedPreferences` にカテゴリ名の配列として保存し、次回起動時に復元する。インデックス番号は保存しない。

\* 保存されたカテゴリ名のうち、現在存在する運営カテゴリだけを保存順で採用する。現在のカテゴリ一覧に新しいカテゴリが追加されている場合は、保存順に存在しないカテゴリを既定順で末尾へ追加する。

\* 保存データが存在しない、または有効な並び順を復元できない場合は、既定順 `トレンド`、`エンタメ`、`サブカル`、`マネー`、`IT・ガジェット` を使用する。

\* 並べ替えによってカテゴリごとのニュース内容、スクロール位置、表示件数、選択カテゴリ名は変更しない。選択中カテゴリはカテゴリ名を基準に維持する。

\* 並べ替え操作だけを理由にSupabase、Upstash、NewsData.io API、RSS配信元へ通信しない。並び順の保存と復元は端末内だけで完結させる。

**\## 6. ニュース一覧**

**\### 6.1 運営ニュースのデータ源**

運営ニュースはNewsData.ioから取得した記事を使用する。運営プリセットRSSは運営ニュースの取得元として使用しない。

正式経路は概ね次とする。

``` text
Supabase Cron
↓
NewsData.io取得用Edge Function
↓
NewsData.io API
↓
Upstash Redis
↓
Topic前処理
  - Gemma Stage 1: category / subject / event
  - Gemma Stage 2: 非除外記事のfacts[]抽出
  - 掲示板風Topic表示タイトル生成
  - Gemini Embedding
  - Supabase Topic統合
↓
Flutterニュース一覧
```

FlutterからNewsData.io APIを直接呼び出さない。NewsData.io
APIキーはサーバー側Secretsで管理する。

NewsData.ioの取得条件は `language=ja` とし、`country=jp` は指定しない。

NewsData.io取得処理とTopic前処理は分離する。 AI
APIまたはTopic処理の失敗によってNewsData.ioの定期取得を停止させない。

**\### 6.2 記事の統合と並び順**

Topic統合導入後の運営ニュースは、掲載対象記事をTopic単位で扱う。

1\.
同一Topicへ複数記事が属する場合、運営ニュース一覧上では同じTopicを重複表示しない。

2\. Topic作成時の最初の記事をV1の代表記事とする。

3\.
代表記事のタイトル、URL、配信元名、description等は、後続記事が同じTopicへ追加されてもV1では自動差し替えしない。

4\. TopicはGemmaが抽出した `facts`
をTopic単位の文字列配列として保持する。後続記事が同じTopicへmergeされた場合は、その記事から得た
`facts` をTopicの `facts`
へ追加する。追加時は前後空白を除去し、空文字を除外し、完全一致する文字列だけを重複除去する。意味的に近いだけのfactsは自動統合・削除しない。

5\. V1の運営ニュース掲載基準は `facts`
が1件以上存在することとする。Gemma分類が `除外`
ではないTopicでも、`facts`
が0件の間はTopic自体とarticle-topic紐付けを保持し、後続記事のmerge候補として利用するが、運営ニュース一覧へは公開しない。

6\. `facts` が0件だったTopicへ後続記事がmergeされ、集約後の `facts`
が掲載基準を満たした場合は、その時点で掲載可能Topicへ昇格させる。掲載基準は将来
`facts`
2件以上等へ変更できる設定として扱い、Topic統合ロジックそのものへ固定しない。

7\. 運営ニュース一覧に表示するTopicタイトルは `thread_title`
を優先する。正常な `subject / event`
を持ち、かつ掲載基準を満たしたTopicをタイトル生成対象とする。掲載基準を満たしていないTopicはタイトル生成待ちへ入れず、後続mergeによって掲載可能になった時点でタイトル生成対象とする。

8\. `thread_title` はタイトル生成対象Topicを4件まとめてGemini 3.5
Flash-Liteで生成し、確定後は後続記事のmergeで変更・再生成しない。

9\.
掲載可能Topicは、タイトル生成が完了または失敗確定するまでは運営ニュース一覧キャッシュへ公開しない。タイトル生成に失敗したTopicでは代表記事タイトルを表示タイトルとして使用する。

10\.
Topicの表示カテゴリはTopic作成時の代表記事のGemma分類結果を基本として固定し、後続記事が別カテゴリに分類されてもTopicカテゴリを変更しない。

11\.
Gemma失敗により単独Topicとなった記事では既存NewsData.io→AI速カテゴリ変換結果を使用する。Gemma失敗singletonは正常な
`facts`
を持たないため、今回のfacts掲載基準ではなく既存の失敗fallback仕様に従って掲載可否・表示タイトル・AI生成コンテキストを扱う。

12\. `除外` 記事は運営ニュース候補へ含めず、Topicも作成しない。

13\.
ユーザーのサイト非表示設定は、代表記事の配信元サイトを基準に既存6.8の仕様を適用する。

14\.
V1ではTopic作成後の代表記事変更、カテゴリ再判定、確定済みTopic表示タイトルの再生成は行わない。

運営ニュース一覧カードは、Topic単位の情報を主表示とし、基本構成を次の2行とする。

``` text
スレタイ
日時
```

一覧カードでは配信元名・媒体名を表示しない。ただし、代表記事の配信元名やURL等のデータ自体は、元記事導線、RSS登録、サイト非表示、URLコピー、共有等の既存機能で使用するため保持する。

一覧に表示する日時と基本の並び順は、代表記事の公開日時ではなくTopicレコードの
`created_at` を基準とする。`created_at`
はAI速側でそのTopicが作成された時刻として扱い、後続記事が同じTopicへ追加されても変更しない。並び順は
`created_at` の降順とする。

一覧日時の表示形式は `M/d HH:mm` とする。`created_at`
がUTCで保持・受け渡しされている場合は、日本時間（JST）へ変換して表示する。すでにJSTへ変換済みの値を再変換して時刻をずらさない。

`created_at`
を取得できない既存Topic等では、日時表示と並び順のfallbackとして
`first_seen_at`、それも取得できない場合は代表記事の `published_at`
の順で使用する。fallback値がUTCの場合も同様にJSTへ変換して表示する。

全掲載記事は必ず1つのTopicに所属する。`topic_articles.article_id`
はUNIQUEとし、同じ記事を二重Topic化しない。1つのTopicには複数の
`article_id` を紐付けられ、Topicから所属記事を追跡できる。

**\### 6.3 運営カテゴリの段階表示**

運営ニュースの初期データはUpstash `news:topics` の公開Topic一覧キャッシュとし、各カテゴリ最大10件を表示する。サイト非表示・重複除去等の適用後は10件未満になる場合がある。

\* ユーザーが一覧末尾付近まで下方向へスクロールしたとき、取得済みの未表示候補が残っていれば、メモリ内の表示上限を50件分増やす。この場合は追加通信を行わない。

\* 取得済み候補をすべて表示しており、次ページがある場合は、Supabase RPC `get_public_topic_page` から同カテゴリの公開Topicを最大50件追加取得する。追加取得は `created_at` と `topic_id` のカーソルで行い、OFFSETは使用しない。

\* RPCで取得したTopicは既存候補へ統合し、表示上限を50件分増やしたうえでサイト非表示・重複除去等を適用する。取得結果が50件未満なら最終ページとするため、実際の表示増加件数は50件未満になる場合がある。

\* 初期キャッシュの各カテゴリ最大10件と、メモリ内の表示上限は別である。内部の表示上限の初期値は50件だが、初期取得する候補が各カテゴリ最大10件のため、初期表示も最大10件となる。

\* RPCによる追加取得ではSupabaseへの通信を行うが、NewsData.io API、Upstash、RSSへの追加通信は行わない。

\* 1回の連続スクロール操作では1ページだけ追加する。

\*
PageStorageによる位置復元やプログラムスクロールでは追加表示を発火させない。

`RSS` は50件段階表示の対象外とし、取得済み記事を全件表示する。

**\### 6.4 起動時の取得**

運営ニュースの初期データはUpstash `news:topics`
から取得する。初期表示後の追加取得は、末尾到達時にSupabase RPC
`get_public_topic_page(category, cursor_created_at, cursor_topic_id, limit)`
を使用する。

起動時は次の順で処理する。

1\. 端末の保存ニュース・ユーザーRSS・サイト非表示設定を読み込み、運営カテゴリと必要に応じた `RSS` タブからカテゴリ一覧を構築する。

2\. `SharedPreferences` から前回選択カテゴリ名を読み込む。保存カテゴリ名が存在すれば初期カテゴリとして適用し、存在しなければ先頭カテゴリを選択する。

3\. 初期カテゴリが運営カテゴリの場合は、Upstash `news:topics` から全運営カテゴリの初期候補を取得し、選択カテゴリを最大10件表示する。初期カテゴリが `RSS` の場合は、ユーザー登録RSSの既存取得経路を使用する。

4\. 初期カテゴリの取得後、別系統の候補をバックグラウンド取得する。運営カテゴリを先に取得した場合はユーザーRSS、`RSS` を先に取得した場合は運営ニュースの初期キャッシュを取得する。運営カテゴリの次ページを起動時に一括取得する処理ではない。

カテゴリ切替だけを理由にNewsData.io APIを呼び出さない。

**\### 6.5 運営ニュースの取得失敗時**

運営ニュースはFlutterからNewsData.ioへ直接フォールバックしない。

Upstash `news:topics` の取得に失敗した場合は、取得済みのメモリ上の運営ニュースを維持する。メモリ上に候補がなければ、端末のTopic一覧キャッシュ `local_topic_list_cache` を表示する。利用可能なデータがない場合は取得失敗状態を表示する。

ユーザーRSSの取得失敗時はRSSタブの既存フォールバック仕様を使用する。

**\### 6.6 手動更新**

更新ボタンまたはPull to refreshで運営ニュースを更新する場合、NewsData.io
APIを呼び出さず、Upstash `news:topics` の最新の公開Topic一覧キャッシュを再取得する。

ユーザー操作回数によってNewsData.io APIクレジットを消費しない。

運営ニュース更新成功後は次の状態にする。

\* RPCで追加取得した候補を含む運営ニュースを、再取得した初期キャッシュの候補へ置き換え、全運営カテゴリ候補を再構築する。

\* 各カテゴリの表示を初期キャッシュの最大10件へ戻す（サイト非表示・重複除去等の適用後は10件未満になり得る）。内部の表示上限は50件へリセットするが、更新時に50件取得・表示するという意味ではない。

\* 次ページ有無・追加取得中のカテゴリ別状態をリセットし、その後の末尾到達時は6.3の追加取得経路を使用する。

\* 5つの運営カテゴリのスクロール位置を先頭へ戻す。

`RSS`
タブの更新は運営ニュースとは分離し、既存のユーザーRSS更新仕様に従う。

**\### 6.7 ニュースカード長押しメニュー**

`RSS` タブ以外の運営ニュースTopicカードは、通常タップと長押しを分離して扱う。

-   通常タップではニュース詳細を開く。
-   長押しではTopic用BottomSheetを表示し、通常タップによるニュース詳細遷移を同時発火させない。
-   Native広告等の広告枠は長押しメニューの対象外とする。

長押し時のBottomSheetは、Topic化後の元記事構成を確認できる「ソース」導線とする。

1.  第1段階ではTopicタイトルと `ソース` を表示する。
2.  `ソース` を選択すると、そのTopicを構成する元記事一覧を表示する。各項目には媒体名と元記事タイトルを表示する。
3.  ソース一覧はFlutter側で1ページ5件ずつ表示する。5件を超える場合は端末側でページを切り替え、5件以下の場合はページ操作を表示しない。バックエンドからは取得可能な構成元記事を全件取得し、表示ページングだけを端末側で行う。
4.  元記事を選択すると、媒体名・元記事タイトルと `ソースをブラウザで開く`、`この媒体をRSS登録` を表示する。

`ソースをブラウザで開く` は既存の元記事表示処理を使用する。

`この媒体をRSS登録` は、選択した元記事のURLと媒体名を使用して9.6の既存RSS探索・登録処理を開始する。元記事情報にfeed URLを保持することは必須としない。

ソース一覧は通常のニュース一覧データへ常時含めず、ユーザーが長押しして `ソース` を選択した場合だけ遅延取得する。

ソース取得は専用Edge Functionへ `topic_id` を渡し、バックエンド側で次の順に処理する。

1.  Supabase `topic_articles` から対象Topicに紐づく `article_id` を取得する。
2.  Upstash Redisの `newsdata:article:${id}` をMGETし、構成元記事情報を取得する。
3.  Flutterへは `article_id`、`title`、`url`、`source_name`、`published_at` 等、このUIに必要な項目だけを返す。

この機能のために `topic_articles` へtitle / url等を二重保存せず、DB schema、Topic作成・merge処理、commit RPC、通常の `news:topics` キャッシュ構造は変更しない。

`newsdata:article:${id}` は7日TTLであるため、古いTopicでは一部または全部の元記事情報を取得できない場合がある。

-   一部だけ取得できない場合は、取得できた元記事を表示する。
-   全件取得できない場合は、ソース情報を取得できない旨を表示し、画面を異常終了させない。
-   ソース取得バックエンドでは構成元記事数に固定の表示上限を設けず、取得可能な元記事を返す。5件単位の表示制御はFlutter側で行う。

**\### 6.8 サイト非表示**

`このサイトを非表示にする`
は、記事単位ではなく配信元サイト単位で運営ニュースから記事を除外する機能とする。

-   対象はトレンド、エンタメ、サブカル、マネー、IT・ガジェットの運営5カテゴリとする。
-   `RSS` タブおよび保存ニュースには非表示設定を適用しない。
-   非表示サイトは端末ローカルの `SharedPreferences`
    に保存し、アプリ再起動後も維持する。Supabase、Upstash、NewsData.io上のデータは削除・変更しない。
-   サイト判定キーは対象記事URLのホスト名とする。ホスト名は小文字化し、先頭の
    `www.`
    を除去して正規化する。その他のサブドメインは別サイトとして扱う。
-   表示名には記事の配信元名を使用できるが、非表示判定そのものは正規化したホスト名を基準とする。
-   非表示操作時に確認ダイアログは表示せず、即時に反映する。現在開いているニュース詳細画面は強制的に閉じない。
-   非表示後は全運営カテゴリの候補記事から同一サイトの記事を除外する。候補が残っている場合は後続記事を繰り上げ、6.3
    の初期最大10件・50件単位の追加取得／表示上限拡大を維持する。非表示操作自体を理由とする追加通信は行わない。
-   非表示操作によって一覧を先頭へ戻さず、現在のスクロール位置を可能な限り維持する。
-   非表示成功時は `○○の記事を非表示にしました`
    のSnackbarを表示し、`元に戻す` を提供する。`○○`
    には配信元名を優先し、利用できない場合は正規化ホスト名を使用する。
-   `元に戻す`
    では該当サイトの非表示設定を解除し、通信を行わずメモリ上の運営ニュース候補を再構築する。現在の表示件数およびスクロール位置は可能な限り維持する。
-   設定画面に `非表示にしたサイト`
    を設け、非表示サイトを一覧表示して個別に解除できるようにする。設定画面からの解除も追加通信を行わず反映する。
-   非表示適用後に対象カテゴリの記事が0件となった場合は、既存のニュースなし状態を表示する。

**\## 7. NewsData.io定期取得**

**\### 7.1 基本方針**

NewsData.io取得はSupabase CronからEdge
Functionを5分間隔のDispatcherとして起動し、Edge
Functionが各取得モードの設定値、現在時刻、当日クレジット使用量、直近15分のクレジット使用量、各モードの次回取得予定時刻を確認してNewsData.io
APIを呼び出すか判定する。

Dispatcherが起動しただけではNewsData.io
APIを呼び出さない。取得不要な回は必要最小限の処理で終了し、NewsData.io
APIクレジットを消費しない。

取得モードは `normal`、`tech`、`subculture`
の3種類とする。各modeの取得予定時刻と予算は独立して管理し、1回のCronで取得するmodeは最大1つとする。複数modeが取得可能な場合は保存した `rotation_index` から `normal` → `tech` → `subculture` の順に循環選択する。Cron 1回につきNewsData.io API requestは最大1回とし、次ページ取得は行わない。

NewsData.ioの共通取得条件は次とする。

``` text
language: ja
country: 指定しない
1 request: 最大10件
normal日次上限: 80 credits
tech日次上限: 12 credits
subculture日次上限: 8 credits
日次共通上限: 100 credits
15分クレジット上限: 30
quota day開始: 09:00 JST
1実行あたり: 最大1 mode・1 request・1 page
追加ページ予備: 0 credits（追加ページ取得は禁止）
理論上の日次取得上限: 100 requests / 1,000 articles
通常スケジュールの24時間mock実行: 62 requests / 最大620 articles
余剰credits消化のための動的な取得頻度増加: 禁止
retry: なし
記事保持: 7日
ジョブログ保持: 30日
```

日次クレジット上限、15分クレジット上限、quota
day開始時刻、モード別取得間隔、モード別予算、追加ページ上限、記事保持期間、ジョブログ保持期間等の運用パラメータは設定値として一箇所に集約し、スケジューラ本体へ分散して固定しない。

スケジューラ本体は設定値を解釈して取得可否を決定する汎用ロジックとし、通常の間隔変更や予算変更では取得制御ロジックそのものを変更しない構造とする。

**\### 7.2 normal取得**

`normal`
は運営ニュース全体を広く取得する主取得モードとする。1回の取得機会につき1
requestだけ実行し、最大10件を取得する。同一取得機会でページ送りしない。Dispatcherは5分ごとに起動するが、実取得は次回取得予定時刻と日次予算に従う。

`normal` の取得可能判定に用いる時間帯別intervalは次とする。実取得は5分間隔のDispatcherで期限到来を確認したときに行う。

``` text
09:00-13:00: 24分間隔
13:00-14:00: 32分間隔
14:00-17:00: 60分間隔
17:00-01:00: 28分間隔
01:00-05:00: 60分間隔
05:00-07:00: 40分間隔
07:00-08:00: 28分間隔
08:00-09:00: 30分間隔
```

normalの取得間隔は従来値の2倍とする。Cronの起動機会は1日288回だが、取得間隔により通常の24時間mock実行は42 normal requestsとなる。1,000記事/日の理論上限を目標に取得間隔を短縮してはならない。

`normal` の日次上限は80 creditsとする。余剰creditsを使い切るための取得頻度変更は行わない。

**\### 7.3 tech / subculture補助取得**

`tech` と `subculture` は `normal`
とは独立した補助取得モードとし、それぞれ専用の次回取得予定時刻を持つ。

初期設定は次とする。

``` text
tech:
  基本取得間隔: 120分
  基本予算: 12 credits / quota day
  追加ページ予備: 0 credits / quota day

subculture:
  基本取得間隔: 180分
  基本予算: 8 credits / quota day
  追加ページ予備: 0 credits / quota day

3 mode共通の日次上限は100 creditsとする。
```

基本取得では1ページ目を1 requestとして取得する。取得結果にかかわらず追加ページrequestは送信しない。

1回の補助取得機会で取得するページは1ページとし、追加ページrequestは行わない。

追加ページ予備は0とし、追加ページは取得しない。各modeの基本取得は割当予算を超えて実行しない。

**\### 7.4 クレジット配分とQuota Day管理**

アプリ側でquota dayごとのNewsData.io API request数を管理する。API
requestを送信した時点で、成功・失敗にかかわらず1
credit消費として自前カウンターへ計上する。

自前カウンターはスケジューリング用の推定値として扱い、NewsData.ioが返すquota
exhaustedを実際の使い切り判定とする。

日次予算配分は次とする。

``` text
normal上限: 80 credits
tech基本配分: 12 credits
tech追加ページ予備: 0 credits
subculture基本配分: 8 credits
subculture追加ページ予備: 0 credits
合計: 100 credits
```

各モードは通常スケジュールと予算上限に従う。`normal`
は残りcreditを使い切るための動的な高頻度化を行わない。

直近15分の自前クレジット使用量は、全mode共通で30を超えないよう制御する。

quota exhaustedを確認した後は、次のquota day開始まで定期取得を停止する。

09:00 JST以降は新しいquota
dayとして各モードの予算、追加ページ予備、次回取得予定を新しいquota
dayへ切り替える。実際のNewsData.io側リセット境界が設定時刻と異なる場合に確認できるよう、quota
exhausted発生時刻と、その後最初に取得成功した時刻をログから追跡可能にする。

前quota dayでquota exhaustedを確認していた場合、その事実は新quota
dayへ引き継ぎ、当日のNewsData.io
API取得が最初に成功するまで保持する。09:00 JST直後のtimeout、connection
error等ではこの状態を解除しない。引き継ぎ状態を保持したままApiLimitExceeded等のquotaエラーを受けた場合は、NewsData.io側のquotaリセット反映待ち（reset
lag）として既存のProbe処理へ移行する。最初のAPI取得成功後は引き継ぎ状態を解除し、それ以降のquotaエラーは当日quotaの使い切り判定として扱う。

**\### 7.5 実行優先順位と15分上限制御**

同じDispatcher起動時に複数モードが取得対象となった場合は、前回選択modeの次から循環して取得可能なmodeを1つだけ選ぶ。

``` text
normal
tech
subculture
```

同一Dispatcher runで複数modeを順次取得しない。選ばれなかったmodeは独立した次回取得予定と予算を保持し、後続Cronで再評価する。

日次クレジット管理とは別に、全取得モード・全ページを合算した直近15分のAPI
request履歴を管理する。NewsData.io
APIを呼び出す前に直近15分の自前クレジット使用量を確認し、30 credits /
15分を超えるrequestを送信しない。

15分上限制御は、NewsData.io側のrate
limitエラーを受けてから停止するのではなく、アプリ側で事前に抑止する。

**\### 7.6 エラー、二重実行防止、停止**

NewsData.io API
requestが失敗した場合、自動retryは行わない。失敗requestも自前クレジットカウンターでは1
credit消費として扱う。

対象にはHTTP 4xx / 5xx、timeout、connection error、NewsData API
error、rate limit、quota
limit、JSON解析失敗、レスポンス形式異常、内部処理例外を含む。

取得中にエラーが発生した場合は、その実行を終了する。エラー前に正常取得・保存できた記事は維持する。

quota exhaustedは通常の一時エラーとは区別し、そのquota
dayの実クレジット使い切り判定として扱う。rate
limitが発生した場合はログへ記録し、15分上限制御の状態を確認できるようにする。

DispatcherおよびNewsData.io API取得を重複実行しない。run
lock、モード別の次回取得予定時刻、取得slot、job
id等を用いて、同一取得機会の二重requestを防止する。

`normal`、`tech`、`subculture`
はそれぞれ独立した次回取得予定を管理する。`rotation_index` は複数modeがdueのときに、次に選ぶmodeを1つ決める巡回位置として使う。

NewsData.io取得をコード再デプロイなしで停止できる有効・無効設定を持たせる。

**\## 8. NewsData.ioキャッシュとログ**

**\### 8.1 記事キャッシュ**

NewsData.io記事はRSS用キーとは別名前空間でUpstash Redisへ保存する。

記事は概ね次を保持する。

``` text
article_id
title
description
url
source_name
published_at
image_url
newsdata_categories
app_categories
fetched_at
```

記事全文、WebView抽出本文、AIレス本文、不要なAPIレスポンス全体、APIキー、認証情報は保存しない。

記事本体は1件だけ保存し、複数カテゴリに該当する場合もカテゴリごとに複製しない。

記事保持期間は7日とし、設定値として管理する。

**\### 8.2 取得ジョブログ**

NewsData.io取得結果は記事キャッシュとは別に保存し、後から時間別推移、取得効率、クレジット消費、エラーを確認できるようにする。

少なくとも次を保持する。

``` text
run_started_at
run_finished_at
quota_day
trigger
scheduler_mode
requested_requests
successful_requests
raw_fetched
unique_in_run
already_known
new_articles
credits_counted
daily_credits_used
credits_remaining_estimate
stopped_by_error
error_request_index
error_type
error_status
error_code
error_message
next_fetch_at
next_tech_fetch_at
next_subculture_fetch_at
normal_credits_used
tech_credits_used
subculture_credits_used
elapsed_ms
```

`scheduler_mode` は通常取得、burn-down、前倒しburn-down、rate
limit待機、quota exhausted等を区別できるようにする。

内部時刻はUTCで保持してよいが、quota
dayおよび運用確認では日本時間へ変換可能にする。

Dispatcherが取得不要と判定しただけの実行について、毎回詳細なジョブログを保存する必要はない。Upstash
Redisのコマンド数を不必要に増やさない。

**\### 8.3 リクエスト単位ログ**

各NewsData.io API requestについて、少なくとも次を記録できる構造とする。

``` text
request_index
started_at
finished_at
items
new_items
already_known_items
status
error_status
error_code
elapsed_ms
credits_counted
daily_credits_used
scheduler_mode
request_mode
page_index
is_burst_page
```

`new_items` と `already_known_items`
は実際の重複判定結果から記録し、`published_at`
等から後から推定する方式を前提としない。

`request_mode` は `normal` / `tech` / `subculture` を区別する。ページ番号・burst情報のログ項目は過去ログ互換のため保持し、低頻度運用中は全requestが1ページ目で追加ページではない。

これにより、時間帯別の新規率、重複率、取得効率、エラー、クレジット消費を後から正確に確認できるようにする。

**\### 8.4 quota / rate limit観測**

少なくとも次を後から確認可能にする。

``` text
quota_exhausted_at
first_success_after_quota_exhausted
recent_15m_credits
daily_credits_used
```

これにより、設定上のquota
day開始時刻とNewsData.io側の実際のリセット境界に差がある場合も、運用ログから確認できるようにする。

**\### 8.5 ログ保持と機密情報**

NewsData.ioのジョブログ保持期間は30日とし、設定値として管理する。

Supabase Cronの実行履歴 `cron.job_run_details`
は直近7日分を保持し、7日を超えた履歴は定期的に削除する。

ログにはNewsData
APIキー、Supabase認証情報、Upstash認証情報、記事本文全文、description全文、AIレス全文、ユーザー投稿本文を保存しない。

エラーメッセージは必要最小限とし、APIレスポンス本文全体をそのまま保存しない。

Cron実行と手動実行は `trigger = cron` / `trigger = manual`
等で区別する。

**\### 8.6 Topic前処理とTopic統合V1**

**\#### 8.6.1 目的**

NewsData.ioから取得した記事について、同じ対象について起きている同じ出来事を1つのTopicへまとめる。

Topicは将来的に共有AIスレッドを共有する単位として利用できる構造とする。
V1では複雑な続報判定や関連Topic判定を行わず、単純で観測可能な統合処理を優先する。

全掲載記事は必ず1つのTopicに所属する。
Topic処理に失敗した記事も例外的な記事型にはせず、1記事だけを含む単独Topicとして扱う。

`除外` 判定の記事だけはTopicを作成しない。

**\#### 8.6.2 Topic前処理の単位**

NewsData.io取得処理とTopic前処理は分離する。

V1ではGemma 4 26Bの安定性を優先し、Topic
workerは1回の実行につき1記事を処理する。 Gemmaへ渡す単位も1記事とする。

Gemmaへ送る前に、AI判断を必要とせず機械的に確定できる不正・重複だけを前処理する。
- Upstash記事ロード後、タイトル・URLを検証して記事URLを一度fetchしMozilla Readabilityで本文を抽出する。descriptionが欠損していても本文取得へ進める。Readability本文が1文字以上なら処理を続け、取得失敗時は既存の `excluded_invalid_article` と `article_body` ログで記事単位に除外する。失敗記事はStage 1 / Stage 2へ送らず、title + descriptionだけでAI分析を継続せず、既存Topicは削除しない。HTTP 429/5xx、timeout、通信エラーだけ最大1回再試行する（各要求timeout 12秒、間隔500ms）。DOM解析、Readability解析、本文0文字は再試行しない。`article_body` 観測ログには成功・失敗、抽出方式、Readability状態、本文文字数、redirect状態、HTTP status、処理時間だけを保存し、本文全文は保存しない。ログは既存の7日保持を使う。
- Readability本文の抽出成功直後、Gemma Stage 1前に投稿構造を機械判定する。投稿番号候補（1〜3桁の番号と半角/全角コロン。直後に数字が続く候補は除外）ごとに、その後130文字以内で複数のコロン、日時形式、ID/不透明識別子の3特徴中2つ以上を含むヘッダーを数える。該当ヘッダーが5件以上かつ全候補の50%以上の場合、`excluded` として記事単位で終了する。判定不能時は通常処理を継続する。特定の投稿者名や単語頻度では判定しない。
- 投稿構造による除外は既存の `topic_processing_logs` / queue terminal status `excluded` を再利用し、log stage=`comment_structure`、error type=`repeated_post_headers`、error messageには該当ヘッダー数と投稿番号候補数だけを記録する。本文・投稿者名は記録しない。Stage 1 / Stage 2 / Embedding / Topic作成へ進めず、既存Topicは削除しない。
- Facts生成のGemma Stage 2入力にはtitle、description、cleaned bodyを含める。Stage 1はtitle + descriptionのままとし、description欠損時だけ取得本文をdescription欄の代替入力として使う。本文最大長/token上限はV1では定めない。

-   `title`
    がnull、空文字、またはtrim後に空の場合はGemmaへ送らず除外する。
- `description` がnull、空文字、またはtrim後に空でも、titleとURLが有効なら本文取得を試みる。Readability本文取得成功時だけStage 1 / Stage 2へ進める。
-   Topic処理に必須の識別情報が欠落・不正で、機械的に処理不能と確定できる場合はGemmaへ送らず除外する。
-   すでに処理済みの記事はGemmaへ再送せずスキップする。
-   「面白いか」「掲載価値があるか」「情報量が十分か」等の意味判断はGemma前の機械フィルタでは行わない。

Gemma前フィルタと処理済みスキップは、少なくとも次を区別してログへ記録できるようにする。

``` text
excluded_missing_title
excluded_missing_description
excluded_invalid_article
already_processed
```

概念上の処理順は次とする。

``` text
NewsData.io記事
↓
Topic processing queue
↓
1記事をclaim
↓
機械的前フィルタ / 処理済み判定
↓
本文取得・Readability抽出
↓
投稿ヘッダー反復フィルタ（条件一致時にexcluded）
↓
Gemma Stage 1でcategory / subject / eventを生成
↓
category=除外なら終了
↓
Gemma Stage 2でfacts[]を生成
↓
カテゴリに応じたEmbeddingモデルを選択
↓
Embedding
↓
記事ごとにTopic候補検索
↓
既存Topicへmerge または 新規Topic作成
↓
Topicのfactsを更新し、掲載基準を判定
```

Topic判定・成功失敗の単位は常に記事単位とする。

Topic workerのV1初期スケジュールは30秒間隔を基本候補とし、1
runにつき最大1記事を処理する。
この場合の理論上限は2,880記事/日であり、1日約2,000記事の流入に対して処理余力を持たせる。

Topic統合V1の導入以前にUpstashへ保存済みの記事を全件遡及処理せず、V1稼働開始後の新着記事からTopic処理を開始する。

#### 8.6.3 Topic分類・facts抽出と表示タイトル生成\*\*

Topic前処理は、1記事につき分類とfacts生成を別requestへ分離した2段階とする。Stage 1分類はGroq上のQwen 3.8 27B / GPT-OSS 20Bを時間帯別に主モデル・fallbackモデルとして使用する。Stage 2 facts生成はGemma 4 26Bを使用し、1回のrequestで担当させる責務を限定する。

Stage 1（classification）へ渡す記事データは基本的に次とする。

``` text
title
description
```

Stage 1では次だけを生成する。`facts` は生成しない。

``` text
subject
event
category
```

`category` は4.1の固定6分類から選択する。

``` text
トレンド
エンタメ
サブカル
マネー
IT・ガジェット
除外
```

各項目の役割は次とする。

-   `subject`: 記事の中心となる対象。40文字以内。
-   `event`: `subject` に何が起きたか。50文字以内。
-   `category`: 4.1の固定6分類。

`category = 除外` の場合はStage
1で処理を終了する。facts生成、Embedding、Topic作成へ進めない。

`category` が `除外` 以外の場合だけStage 2（facts
generation）を別のGemma requestとして実行する。Stage
2へ渡す入力は基本的に次とする。

``` text
title
description
cleaned_body
```

Stage 2では分類をやり直さず、`facts[]` だけを生成する。

`facts` は次のルールとする。

-   件数上限は設けない。
-   1要素には原則として1つの情報を入れる。
-   1要素は原則50文字前後の簡潔な表現とするが、情報を失わせる厳密な文字数上限は設けない。
-   複数の情報がある場合は、必要に応じて複数のfactへ分割する
-   Do not infer or add facts that are unsupported by `title`, `description`, or `cleaned_body`.
-   `facts` は単純な文字列配列とし、`fact / plan / claim`
    等の型分類は持たせない。
-   具体的factを抽出できないときは `facts: []`
    を許容する。factsが0件であることだけを理由にStage 1の `category`
    を変更しない。

Stage 1はGroq Chat Completionsのstrict JSON Schema structured outputを使用する。既存のStage 1 parserでcategory、subject、event、長さ、反復を検証する。
Stage 2はJSON structured outputを使用せず、プレーンテキストで1行につき1つのfactだけを生成する。
Stage 2の出力にはJSON、Markdown、番号、箇条書き、ラベル、説明文を含めない。
GemmaのStage 2生成結果はサーバー側で改行単位に分割し、前後空白と空行を除去して機械的に `facts[]` へ変換する。JSON化のための追加requestは行わない。

Stage 1は既存どおり `temperature = 0` を維持する。 Stage
2はfacts抽出時の反復ループを予防するため `temperature = 0.8`
を使用する。用途ごとの `maxOutputTokens` は別設定として管理し、Stage
1は短い分類出力、Stage 2はfacts出力に必要十分な上限とする。

Stage 2のfacts生成はGemini APIのStreamingを使用し、
`streamGenerateContent` のSSEレスポンスから生成テキストを順次連結する。
新しいSDKへの移行は行わず、既存のHTTP `fetch`
ベースの呼び出しを維持する。表示タイトル生成の通信方式は変更しない。

Stage
2では生成途中の反復暴走を早期停止するため、既存の反復検出ロジックをStreaming中の累積生成テキストにも適用する。
初期判定条件は、累積生成テキストが100文字以上、かつ前回判定から64文字以上増加した時点とする。
短周期反復、末尾反復、極端な低多様性等の明確な生成崩壊を検出した場合は、
HTTP StreamingをAbortし、そのStage 2バッチを
`error_type = repetition_loop`
として扱う。途中まで生成済みのfactsは部分保存しない。
反復検出によるAbortとtimeout・network errorは区別して記録する。

Stage 2がStreamingを正常完了した場合は、連結したプレーンテキストを
改行単位で分割し、各行を1つのfactとして `facts[]` へ変換する。
前後空白と空行の除去は機械的に行ってよいが、生成内容の要約・補完・言い換えは行わない。
変換後の各factには既存の反復検出を適用し、反復が検出された場合は
`error_type = repetition_loop` として扱い、部分保存しない。
したがってStage 2は、`temperature = 0.8` による反復予防、
Streaming中の反復検出と早期Abort、`maxOutputTokens` による出力上限、
正常完了後のfacts validationと反復検出を組み合わせて生成崩壊を防止する。

Stage 2ではThinking Configを固定し、
`thinkingConfig: { thinkingLevel: "MINIMAL" }`
を使用する。`thinkingBudget` 等は追加せず、 APIから
`usageMetadata.thoughtsTokenCount`
が返る場合は既存diagnosticsで観測できる状態を維持する。
`frequencyPenalty`、`presencePenalty` も今回の仕様には追加しない。

Stage 2ではMarkdownコードフェンスを出力させない。Stage 2のプレーンテキスト出力を機械的に `facts[]` へ変換する際、内容の補正は行わない。

Stage 1では、JSON parse失敗を `invalid_json`
と確定する前に既存の反復暴走検出を行う。 Stage
2ではStreaming中の早期検出に加え、正常完了後の既存parserでも同じ反復暴走検出を行う。
いずれも明確な生成崩壊は `error_type = repetition_loop` として区別する。

Topic用文字列はGemmaへ自由生成させず、Stage
1の結果からアプリ側で次の形式により作る。

`topic_text = subject + " | " + event`

Stage 1はJST 00:00〜11:59にQwen 3.8 27B、GPT-OSS 20Bの順、JST 12:00〜23:59にGPT-OSS 20B、Qwen 3.8 27Bの順で使用する。主モデルのtimeoutだけ同じ記事を最大1回再試行し、その他のAPI失敗または出力検証失敗では再試行せずfallbackモデルへ進む。fallbackモデルは追加retryしない。両モデルで失敗した場合は既存のsingleton fallbackへ進む。timeout初期値は30秒、最大出力tokenは512とする。

Stage 2のfacts生成に失敗した場合は、Stage 1で正常に得た
`subject / event / category`
を破棄しない。factsは空として扱い、既存のEmbedding・Topic統合処理へ進める。作成またはmergeされたTopicは
`facts.length >= 1`
の掲載基準を満たすまで非公開とし、後続記事のmerge候補として保持できる。Stage
2はHTTP 500 / 502 / 503 / 504だけ最大3回retryし、初回を含めて最大4回のStage 2 requestとする。短い待機はretry前に500ms、1000ms、2000msとし、`Retry-After` がこれより長ければその時間を優先する。`Retry-After` が5秒を超える場合はWorker内で待機せず、既存の `topic_processing_queue.available_at` に次回処理予定を保存してclaimを解放する。各requestは既存quota予約を通し、quota不足で追加送信を止める。

HTTP 429では即時retryしない。レスポンスの制限軸・`Retry-After` / Gemini `retryDelay` とread-only quota判定を使い、Providerと内部quotaの次回利用可能時刻のうち遅い方を `available_at` に保存する。軸がRPM/TPMと判別できず待ち時間も得られない場合は次のPT日次境界まで延期する。延期は同じqueue rowのclaim RPCで再開し、新しいqueue・Cron・schedulerは追加しない。Stage 2の累積attemptはqueue上で最大4回とし、quota予約で送信を止めたattemptも上限に含める。延期期限前はclaimせず、他記事のqueue処理を続ける。

HTTP 400 / 401 / 403、JSON解析・出力形式エラー、反復出力、timeoutはretryしない。通信切断も送信状態が安全と確認できないためretryしない。最大attempt到達後の失敗はfactsを空として既存のEmbedding・Topic統合処理へ進める。retry中のHTTPエラー、retry数、最終status、quota停止理由、延期予定は既存 `topic_observability_logs` に記録し、retryで成功したrequestを最終失敗として集計しない。

Stage 2が正常に `facts[]` を返した記事も、`facts`
が0件であればTopic統合処理へ進め、一覧掲載だけを保留する。

Gemmaによる `thread_title`
生成は行わない。表示タイトル生成はTopic作成後の別工程としてGemini 3.5
Flash-Liteへ分離する。

表示タイトル生成対象は、正常な `subject / event`
を保持し、かつ現在のTopic掲載基準を満たしたTopicとする。新規Topic作成時点で掲載基準を満たさない場合はタイトル生成待ちへ追加しない。後続記事のmergeによってTopicの
`facts`
が増え、掲載基準を初めて満たした場合は、その時点でタイトル生成対象へ追加する。

既存Topicへmergeした記事は、すでにそのTopicの `thread_title`
が確定済みならタイトル再生成の対象外とする。後続記事のmergeによって
`thread_title` を変更・再生成しない。

Stage 1失敗により `subject / event`
を正常に得られなかったsingletonはGeminiタイトル生成対象外とする。Stage
2失敗、Embedding失敗またはVector検索失敗でsingletonとなった場合でも、正常な
`subject / event`
を保持し、掲載基準を満たしているTopicはタイトル生成対象としてよい。

タイトル生成対象Topicは、Topic本体を `thread_title = null`
で先に作成し、タイトル生成待ちとして保持する。これにより、先に作成されたTopicを後続記事のmerge候補として利用する既存の逐次処理を維持する。

タイトル生成は次の条件で行う。

``` text
model: gemini-3.5-flash-lite
thinkingLevel: medium
batch size: 4 Topics 固定
temperature: 0
responseMimeType: application/json
structured output: 使用
maxOutputTokens: 8192
timeout: 30秒
retry: なし
thread_title: 47文字以内を生成目標とする。超過しても採用
```

タイトル待ちTopicが4件揃うまでAPIを呼ばない。1〜3件の端数を時間経過でflushしない。日をまたいでも未処理Topicを破棄せず、次の対象Topicが追加されて4件になるまで待機する。大量待機時の上限や古いTopicの扱いはV1では未確定とし、別途検討する。

Geminiへ渡す各Topicの入力は次の3項目だけとする。

``` text
id
subject
event
```

`facts`、`category`、元記事
`title`、`description`、URL、媒体名はタイトル生成APIへ渡さない。

タイトル生成指示は次を基本とする。

``` text
あなたは5ch風の匿名ニュース掲示板で、ニューススレッドを立てる編集者です。

報道機関のニュース見出しではなく、掲示板ユーザーが思わず開きたくなるスレタイを作成してください。

【タイトルの構成】

ニュースの内容に合わせて、次の表現方法から最も面白くなるものを選んでください。

A. 意外な事実を短く言い切る
B. ニュースの内容に対して疑問を投げかける
C. 特徴的な数字や出来事を強調する
D. ニュースにツッコミを入れる
E. 普通のニュース見出しにする
F. その他、読者の興味を引く自由な表現

ニュースごとに自由に構成を選び、匿名掲示板らしいスレタイを作成してください。

【出力】
- 47文字以内。
- 各ニュースにつきタイトルは1つ。
- 指定されたJSON形式だけを返す。
```

4件batchでは、入力された4件すべてについて入力IDをそのまま返すstructured
outputを使用する。少なくとも各要素は `id` と `thread_title` を持つ。

返却後はコード側で、入力4
IDが重複なく対応していること、不明IDがないこと、`thread_title`
が空でないことを検証する。47文字以内はprompt上の生成目標として維持するが、超過したタイトルも採用する。成功した要素を各Topicの
`thread_title`
へ保存する。一部ID欠落、重複、不明ID等があってもbatch全体を巻き戻さず、失敗した要素は再送しない。文字数超過はbatch監査ログの `failure_types.title_length_exceeded` に件数を記録する。この監査カウンターは `failure_count` に加算しない。

タイトル生成APIは成功・失敗理由を問わず一切retryしない。timeout、HTTP
429、HTTP 5xx、network error、invalid
JSON、ID欠落、重複、不明ID等でも同じbatchまたは失敗Topicを再送しない。47文字超過は成功として確定し、再生成や追加API呼び出しを行わない。

掲載基準を満たしたTopicは、タイトル生成が完了または失敗確定した後だけ運営ニュース一覧キャッシュへ公開する。正常な
`thread_title`
を取得できなかったTopicでは代表記事タイトルを表示用fallbackとして使用する。タイトル生成失敗を理由に、すでに確定したTopic分類、Embedding、merge判定、Topic本体を失敗扱いへ戻さない。

無限retryは行わない。

\*\*\

#### 8.6.4 除外とfacts不足Topic\*\*

Gemmaが `除外` と判定した記事は次のように扱う。

-   運営ニュースへ掲載しない。
-   Topicを作成しない。
-   いずれのEmbeddingモデルへも送らない。
-   元記事データは既存Upstash記事キャッシュに残してよい。
-   Topic処理ログへGemmaによる内容除外と分かる状態で記録する。

Gemma前の機械フィルタによる除外は、Gemmaの `category = 除外`
と区別して記録する。

一方、Gemmaが `除外` 以外のカテゴリを返し、正常な `subject / event`
を得られたが `facts`
が現在の掲載基準に満たない記事は、内容除外とは扱わない。

-   Topic統合処理を行う。
-   新規Topicになった場合はTopicを保持する。
-   `topic_articles` の紐付けを保持する。
-   後続記事のmerge候補として検索対象にできる。
-   掲載基準を満たすまでは運営ニュース一覧へ公開しない。
-   掲載基準を満たすまでは `thread_title` 生成対象へ入れない。
-   後続mergeでTopicの集約 `facts`
    が掲載基準を満たした場合は、その時点で掲載可能へ昇格し、タイトル生成待ちへ追加する。

V1初期の掲載基準は `facts.length >= 1`
とする。掲載基準は設定値として管理し、将来 `facts.length >= 2`
等へ変更してもTopic統合・article-topic紐付けそのものを変更しない構造とする。

**\#### 8.6.5 Embedding**

Gemma分類に成功し、`除外` ではない記事について `topic_text`
をEmbeddingへ渡す。

V1では次の2モデルを併用する。

``` text
Gemini Embedding 1 (`gemini-embedding-001`)
Gemini Embedding 2 (`gemini-embedding-2`)
```

両モデルともV1初期次元数は384とする。

カテゴリごとに使用するEmbeddingモデルを固定し、割当は一箇所の設定で管理する。
初期割当は次の暫定値とする。

``` text
トレンド       -> Gemini Embedding 2
エンタメ       -> Gemini Embedding 2
サブカル       -> Gemini Embedding 1
マネー         -> Gemini Embedding 1
IT・ガジェット -> Gemini Embedding 1
```

このカテゴリ→モデル割当はV1暫定値であり、実際の記事比率・quota消費を見てコード再設計なしで変更できる構造とする。

片方のモデルのquotaが尽きても、処理中の記事をもう片方のEmbeddingモデルへ自動的に逃がさない。
担当モデルでEmbeddingできない記事は単独Topicへフォールバックする。

Gemini Embedding 1とGemini Embedding
2は異なるEmbedding空間として扱い、両者のベクトルを直接比較しない。

EmbeddingのHTTP batch
APIを利用しても、RPDはEmbeddingしたテキスト件数分消費されるものとして扱う。
V1ではTopic
workerが1記事単位のため、Embeddingも基本的に1記事単位で実行する。

V1ではEmbeddingを記事ごとに永続保存せず、新規Topic作成時のTopic
Embeddingだけを保存する。 既存Topicへ後続記事が追加されてもTopic
Embeddingは再生成しない。

**\#### 8.6.6 Embedding次元・モデル世代の切替**

384次元はV1の暫定初期値とする。
実データで精度上の問題が確認された場合、768次元へ変更できる構造とする。

Embeddingの比較互換性は少なくとも次の組み合わせで分離する。

``` text
model
embedding dimensions
embedding version / generation
```

異なるモデル、異なる次元、異なる互換性のない世代のベクトルを直接比較しない。

Embedding model / dimensions / versionは一元設定する。 Topic
Embeddingには、後からどの空間のベクトルか識別できる `embedding_version`
等を保存する。

保存・Vector Indexは異なるEmbedding空間を安全に分離できる構造とする。
同じ物理テーブルを使用する場合でも、互換性のないEmbeddingを同じ検索対象へ混在させない。
必要に応じてモデル・次元別テーブルを使用できる。

カテゴリの担当Embeddingモデルを変更した場合、既存Topicを一括再Embeddingしない。
変更後の記事は新しい担当モデル・embedding versionのTopicだけを検索する。
旧モデルのTopicは最大lookback期間後に自然に検索対象外となる。

Topic Embeddingの自動再生成はV1では行わない。

**\#### 8.6.7 Topic候補検索**

新記事のEmbeddingに対し、Supabase上の既存Topicから候補を検索する。

V1の検索条件は次を基本とする。

``` text
category: 新記事のGemma分類と同一
embedding_version: 新記事と同一
lookback: last_seen_at が直近24時間
candidate count: 1
similarity threshold: モデル別設定（V1初期値は各0.88）
```

異なるカテゴリまたは異なるEmbedding空間のTopicをVector比較しない。

Embedding 1とEmbedding
2ではsimilarity分布が異なる可能性があるため、thresholdはモデル別に独立して変更可能な設定とする。
V1初期値は両モデルとも0.88とする。

最上位候補のcosine
similarityが当該モデルの閾値以上なら既存Topicへ統合する。
閾値未満、または候補が存在しない場合は新しいTopicを作成する。

V1では次を行わない。

-   複数候補のAI再比較
-   曖昧ゾーン
-   続報専用ルール
-   関連Topicリンク
-   parent Topic判定
-   Gemmaによる二次同一Topic判定

Topic候補検索・統合・新規作成は記事ごとに順次実行する。

#### 8.6.8 Topic更新\*\*

既存Topicへ記事を追加した場合は少なくとも次を更新する。

`article_count += 1` `last_seen_at = 追加記事の時刻`
`facts = 既存facts + 新記事facts`

`facts` の追加では次を行う。

-   各要素をtrimする。
-   空文字は保存しない。
-   既存 `facts` と完全一致する文字列は追加しない。
-   意味的な類似だけを理由に自動削除・統合しない。
-   Embeddingや別AIをfacts重複除去だけのために使用しない。

Topicの集約 `facts`
が掲載基準未満から基準以上へ変化した場合は、Topicを掲載可能状態へ昇格させる。正常な
`subject / event` を持ち、まだ `thread_title`
が確定していない場合は、その時点でタイトル生成待ちへ追加する。

V1では後続記事追加によって次を更新しない。

-   Topic Embedding
-   subject
-   event
-   topic_text
-   確定済みthread_title
-   代表記事
-   表示カテゴリ

Topicを安定したクラスタとして扱い、後続記事の追加による再分類や代表値の揺れを避ける。

**\#### 8.6.9 24時間lookback**

**Upstash Vectorへの段階移行**

Topic候補の新しいEmbedding検索先は既存Upstash Vector indexの `openai/text-embedding-3-small` とする。入力は常に `subject | event`、namespaceは `topic-openai-v1`、類似度閾値は0.88とする。Upstashで生成したベクトルと既存Gemini 384次元ベクトルを直接比較しない。

移行中はGemini検索を維持する。DB triggerとOutboxでnormal Topicの作成・更新をUpstash namespaceへ同期し、直近24時間の既存Geminiベクトル保持Topicをbackfillする。Outboxが空であることを確認した後にのみ運用設定 `TOPIC_VECTOR_SEARCH_MODE=upstash` へ切り替える。新規作成・mergeもOutboxを経由してUpstashへ同期する。既存Geminiベクトルは保持し、削除しない。

2026-09-26本番移行記録: Outbox migrationを適用し、初回対象71件と差分3件をnamespaceへ同期。Outbox pending 0件を確認し、検索元をUpstashへ切替、topic-processing v34を稼働。既存Geminiベクトルは保持。

OperationsはDBログにある情報のみを表示し、現在の検索mode Secretは参照せず未記録とする。Stage 1のモデル別試行・成功/失敗・timeout retry・fallback理由、Upstash Vector検索の成否・処理時間・失敗理由・Embedding version、Outboxの同期成否・件数・時刻・失敗理由を `topic_observability_logs` に保存する。ログは既存のTopic log保持期間に合わせて7日保持し、検索/同期監視のためだけのUpstash query/upsertは行わない。Upstashの新規Topic/merge数は成功検索数と別にtopic_commitログから集計する。既存のStage 1ログはモデル情報を補完せず、モデル未記録として扱う。成功topic_commitのembedding_versionは直近に成功した記録の観測値であり、現在modeの断定には使わない。`topic_vector_outbox`のpending/claimed/15分超claim件数も読み取る。

Topic検索対象期間は `created_at` ではなく `last_seen_at` を基準とする。

最後に同一Topicへ記事が追加されてから24時間以内であれば、引き続き新記事の統合候補となる。

24時間を超えたTopicは新記事のVector検索対象から外す。

24時間は検索対象条件であり、24時間経過時点でEmbedding行を即時物理削除することまでは要求しない。
古いEmbeddingの物理cleanupは別処理として後から実施できる。

**\#### 8.6.10 Topic処理失敗**

Topic前処理で失敗した記事を自動的に繰り返し再試行しない。

失敗・フォールバック例:

-   Gemma Stage 1（分類）失敗
-   Gemma Stage 2（facts生成）失敗
-   Embedding失敗
-   Embedding quota不足
-   Embedding reset待ち
-   Vector検索失敗
-   Gemini 3.5 Flash-Liteによる `thread_title` 生成失敗
-   Topic保存失敗

`除外`
以外の記事で通常のTopic統合を完了できない場合、その記事だけを含む単独Topicとして扱う。

Gemma Stage 1（分類）失敗時: - `TimeoutError`
の場合だけ、同じ記事に対して最大1回だけ再試行する。 -
再試行もtimeoutした場合、またはtimeout以外のGemma失敗の場合は単独Topicを作成する。 -
Embeddingは持たせず、表示カテゴリは既存NewsData.io→AI速カテゴリ変換結果を使用する。 -
正常な `subject / event / facts`
がないためGeminiタイトル生成対象にはせず、代表記事タイトルを表示用fallbackとして使用する。 -
AIコメント生成ではTopic facts方式を使用せず、既存どおり代表記事の
`title + description` をニュース情報として使用する。

Gemma Stage 2（facts生成）失敗時: - Stage 1で正常に得た
`subject / event / category` は保持する。 - HTTP 5xxの上限内retryと429のqueue延期を適用し、retry上限後の失敗は既存fallbackへ移行する。 -
`facts` は空として扱い、既存のEmbedding・Topic統合処理へ進める。 -
Topicは後続記事のmerge候補として保持できるが、集約 `facts`
が掲載基準を満たすまでは一覧公開しない。 - Stage
2失敗だけを理由にNewsData.ioカテゴリfallbackへ戻さない。

Embedding失敗時: - Gemma分類結果のカテゴリで単独Topicを作成する。 -
Embeddingは持たせない。 - 正常な `subject / event / facts`
を保持し、現在の掲載基準を満たしている場合はタイトル生成待ちへ追加してよい。

担当Embeddingモデルの日次quotaを使用できない場合: -
別Embeddingモデルへ自動fallbackしない。 -
Gemma分類結果のカテゴリで単独Topicを作成する。 -
`embedding_quota_exhausted`
またはreset待ちを区別できる理由をTopic処理ログへ残す。 - 正常な
`subject / event / facts`
を保持し、現在の掲載基準を満たしている場合はタイトル生成待ちへ追加してよい。

Vector検索失敗時: -
記事自体の掲載を止めず単独Topicへフォールバックする。 -
Vector検索を自動再試行しない。 - 正常な `subject / event / facts`
を保持し、現在の掲載基準を満たしている場合はタイトル生成待ちへ追加してよい。

`thread_title` 生成失敗時: -
タイトル生成request自体も、個別Topicも再送しない。 - timeout、HTTP
429、HTTP 5xx、network error、invalid
JSON、ID欠落、重複、不明ID、空文字等を理由にretryしない。47文字超過は成功として採用し、超過数を監査記録する。 -
4件batchの一部だけ正常な場合は正常分を保存し、失敗分だけ
`thread_title = null` のまま確定する。 -
タイトル生成失敗だけを理由にTopic本体を `failed_gemma`、`failed_db`
等へ変更しない。 - タイトル生成結果が確定した後、`thread_title`
がないTopicは代表記事タイトルへfallbackして一覧公開する。

Topic保存自体が失敗した場合は `failed_db`
等としてログへ残し、無限fallbackを行わない。

失敗によってNewsData.io取得処理を停止させない。

\*\*\

#### 8.6.11 重複処理防止\*\*

1記事は複数Topicへ所属させない。 `topic_articles.article_id`
にはUNIQUE制約を設ける。

同じ記事がTopic前処理へ重複投入された場合、既存のarticle-topic所属を確認し、二重Topic作成・二重紐付けを行わない。

V1初期運用ではworker 1 runにつき1記事を処理する。

**\#### 8.6.12 Supabaseデータ構造**

概念上、少なくとも次を保持する。

##### topics

``` text
id UUID
subject
event
topic_text
thread_title
category
facts
representative_article_id
first_seen_at
last_seen_at
article_count
created_at
```

`category` はTopic作成時に固定する。 `facts`
はGemmaが各記事から抽出した具体情報をTopic単位で集約した文字列配列とする。新規Topic作成時は代表記事のfactsから開始し、後続merge時に追加する。前後空白除去、空文字除外、完全一致重複除去だけを行い、各factの元記事由来はV1では保持しない。
`thread_title` はTopicが現在の掲載基準を満たした後、Gemini 3.5
Flash-Liteタイトル生成batchで正常に取得できた場合だけ後付け保存する。後続記事追加では確定済みタイトルを変更しない。タイトル生成失敗またはタイトル生成対象外のTopicではnullを許容し、一覧表示時は代表記事タイトルへfallbackする。
`representative_article_id`
はV1では最初にTopicを作成した記事を指し、後続記事追加では変更しない。

##### topic_articles

``` text
topic_id
article_id
source
published_at
similarity
match_method
created_at
```

`article_id` はUNIQUEとする。 `similarity`
は新規Topic、失敗Topic等ではnullを許容する。 `match_method`
は少なくとも次を区別できるようにする: `new_topic`, `similarity_merge`,
`processing_failed`

##### topic_cache_publish_state

運営ニュース一覧キャッシュ `news:topics`
の更新頻度を制御するため、Topic処理完了件数のカウンタをsingleton状態としてSupabaseに永続化する。

概念上、少なくとも次を保持する。

``` text
completed_count
updated_at
```

Topic処理で記事が完了するたびにRPC内でカウンタを原子的に更新し、10件目だけキャッシュ更新対象として判定してカウンタを0へ戻す。更新時は行ロックを使用し、複数のEdge
Function
invocation間でもカウントを保持するとともに、同時実行による二重更新を防止する。

##### thread_title生成待ち

正常な `subject / event`
を持ち、現在のTopic掲載基準を満たしたタイトル生成対象Topicについて、少なくともTopic
ID、待機開始時刻、処理状態を永続化し、4件単位で排他的にclaimできる構造を持つ。掲載基準未満のTopicは待機キューへ入れず、後続mergeで初めて基準を満たした時点で追加する。

概念上の状態は少なくとも次を区別できるようにする。

``` text
pending
processing
success
failed
```

同一Topicを複数workerが同時にタイトル生成batchへ含めない。API送信前に4件をまとめてclaimし、batch結果に応じて各Topicを
`success` または `failed` へ確定する。1〜3件しかない場合は `pending`
のまま保持する。

##### thread_title API quota state

Gemini 3.5
Flash-Liteのタイトル生成quotaはPT日付単位で永続管理する。少なくとも次を保持できる構造とする。

``` text
quota_day_pt
used_today
quota_exhausted_at
reset_probe_started_at
first_success_after_reset
updated_at
```

`quota_day_pt` は `America/Los_Angeles` の暦日を使用する。API
request送信前にatomicにquotaを1件予約し、API成功・失敗にかかわらず巻き戻さない。

##### Topic Embedding

``` text
topic_id
embedding
embedding_version
created_at
```

Gemini Embedding 1 / 2、384 /
768、および互換性のない世代を安全に分離して検索できる構造とする。

また、Embeddingモデル別の日次quota状態をSupabaseで取得・更新しやすい場所に保持する。
概念上、少なくとも次をモデル別に管理できる構造とする。

``` text
embedding_model / embedding_version
quota_day_pt
used_today
quota_exhausted_at
reset_probe_started_at
first_success_after_reset
updated_at
```

Embedding 1とEmbedding 2のquota stateは独立して管理する。

**\#### 8.6.13 Topic処理ログ**

Topic処理結果は、後からSQL等で取得・集計しやすいSupabaseの専用ログへ保存する。

記事単位のTopic処理では少なくとも次を保持できる構造とする。

-   article_id
-   status (`merged`, `new_topic`, `excluded`, `excluded_missing_title`,
    `excluded_missing_description`, `excluded_invalid_article`,
    `already_processed`, `failed_gemma`, `failed_embedding`,
    `failed_search`, `failed_db`)
-   stage
-   error_type
-   error_message
-   embedding_version
-   candidate_topic_id
-   similarity
-   source_category
-   classified_category
-   fact_count
-   topic_fact_count
-   publishable
-   duration_ms
-   created_at

タイトル生成は記事単位Topic処理とは分離して、batch単位とTopic単位の結果を後から確認できるようにする。少なくとも次を識別可能にする。

``` text
title_batch_id
model
thinking_level
batch_size
http_status
finish_reason
attempts
duration_ms
input_tokens
output_tokens
thinking_tokens
quota_day_pt
used_today_at_request
success_count
failure_count
created_at
```

タイトル生成requestはretryしないため `attempts` は通常1とする。

Topic単位では少なくとも次のタイトル結果を識別可能にする。

``` text
success
timeout
invalid_json
empty
too_long
schema_invalid
missing_id
duplicate_id
unknown_id
rate_limit
http_5xx
network_error
quota_exhausted
quota_reset_pending
```

必要に応じて実際の失敗分類を追加できる。タイトル生成失敗時もTopic本体のTopic処理statusは変更しない。

既存ログ項目に加え、後からEmbedding
quota運用を分析できるよう、少なくとも次を識別可能にする。

-   使用予定/使用したembedding modelまたはembedding version
-   `embedding_quota_exhausted`
-   `embedding_quota_reset_pending`
-   quota系429
-   RPM / TPM / 原因不明429など、日次quota
    exhaustedとは別のEmbedding失敗
-   API送信時点の自前 `used_today`
-   Gemma Stage 1（classification）の成功 / 失敗、処理時間、output
    tokens、finish reason
-   Gemma Stage 2（facts generation）の成功 / 失敗、処理時間、output
    tokens、finish reason
-   Stage 1 / Stage 2それぞれの `repetition_loop` / `invalid_json` /
    `MAX_TOKENS` 件数
-   Topic worker全体の処理時間

ログへニュースdescription全文、AI返却全文、APIキー、認証情報を保存しない。

`topic_processing_logs`
は直近7日分を保持し、7日を超えたログは定期的に削除する。`topic_processing_queue`
は処理済みarticle_idの重複enqueue防止にも使用しているため、この7日保持ルールの削除対象には含めない。

後から少なくとも次を集計可能にする。

-   処理記事数、新規Topic数、統合数、統合率、単独Topic数
-   Gemma内容除外数・除外率
-   `excluded_missing_title` / `excluded_missing_description` /
    `excluded_invalid_article` / `already_processed` の件数
-   facts 0件記事数、掲載基準未満Topic数、後続mergeによる掲載昇格数
-   Gemma Stage 1失敗数・失敗率、Stage 2
    facts生成失敗数・失敗率、Stage別 `repetition_loop` / `MAX_TOKENS` /
    `invalid_json`
    件数、Embedding失敗数・失敗率、Vector検索失敗数、DB失敗数
-   タイトル生成待ちTopic数、生成対象数、成功数、失敗数、成功率
-   タイトル生成request数、batchごとの対象件数
-   タイトル失敗理由別件数
-   Geminiタイトル生成のinput / output / thinking token
-   タイトル生成latency
-   タイトル生成のPT日付ごとのRPD使用量
-   title quota exhausted / reset_pending / Probe件数
-   similarity分布、Gemma分類カテゴリ分布
-   NewsData.io元カテゴリとGemma分類結果
-   Embedding version別件数
-   Embedding 1 / 2ごとの使用件数
-   モデル別quota exhausted発生時の自前カウンタ
-   quota超過・reset待ちによりsingletonとなった件数
-   モデル別similarity分布
-   モデル別threshold評価
-   カテゴリ別Embeddingモデル使用件数

\*\*\

#### 8.6.14 API制限とquota管理\*\*

V1で使用する主なAPI制限は次を基準とする。

``` text
Gemma 4 26B（Topic分類 / facts生成）
RPM: 30
TPM: 16K
RPD: 14.4K

Gemini 3.5 Flash-Lite（thread_title生成）
RPM / TPM / RPD: AI Studioのproject limitsを正とする
内部RPD上限: 490 / PT day

Gemini Embedding 1
RPM: 100
TPM: 30K
RPD: 1K

Gemini Embedding 2
RPM: 100
TPM: 30K
RPD: 1K
```

GemmaはStage 1のclassificationで記事ごとに1request使用する。Stage 1で
`除外` ではない記事だけStage 2のfacts
generationで追加1requestを使用するため、非除外記事は原則2requestとなる。RPD
14.4K/dayの範囲ではrequest数削減より各requestの責務分離と安定性を優先する。表示タイトル生成にはGemmaを使用しない。

Gemini 3.5 Flash-Liteのタイトル生成は4 Topicで1 requestとする。タイトル生成requestは並列実行せず、request開始間隔を最低4.1秒空ける（連続実行時の内部上限は約14.6 RPM）。retryは行わない。

V1のGemini 3.5 Flash-Liteタイトル生成Hard Limitは
`490 / PT day` とする。Gemini APIの実際のrate limitはprojectとusage tierごとに異なるため、AI Studioに表示される有効な制限を正とする。RPDの「日」はJSTではなく `America/Los_Angeles`
の暦日で管理する。

タイトル生成APIを送信する直前にDBのatomic処理で1
request分のquotaを予約する。実際にrequestを送信した後は、成功、timeout、HTTP
429、HTTP 5xx、network
error等を問わず安全側として自前カウンタを巻き戻さない。

`used_today >= 490`
では新しいタイトル生成requestを送信せず、タイトル生成待ちTopicを保持する。

`quota_day_pt`
と現在のPT日付が異なる場合は、前日の使用量にかかわらず日付変更だけを理由に
`used_today = 0` で通常運転へ戻さない。新しいPT日の状態を
`reset_pending` とし、タイトル待ちが4件以上ある時の最初の1
batchをquota復活確認用Probeとして送信する。

Probe成功時は新しい `quota_day_pt` へ切り替え、そのProbeを当日1
request目として `used_today = 1` とし、`first_success_after_reset`
を記録して通常運転へ戻る。ProbeがHTTP 429の場合は `reset_pending`
を維持し、少なくとも5分空けて次のProbeを許可する。

Probeが429だった場合、その4 Topicはタイトル失敗として確定させず
`pending`
へ戻す。次回Probeで再び選ばれることは許容する。これはタイトル品質失敗のretryではなく、外部APIの新しいRPD日が利用可能になったことを確認するためのquota
Probe例外とする。Probe以外のタイトル生成requestは一切retryしない。

Probe以外の通常タイトル生成requestでHTTP
429となった場合も、そのbatchは再送しない。RPD以外の一時的429を理由に自動retryしない。

Embedding RPDはモデルごとに独立して扱う。 HTTP batch
request数ではなく、実際にEmbeddingへ送信したテキスト件数をRPD消費数として管理する。

各Embeddingモデルの公式RPD 1,000に対し、V1の自前内部上限は暫定
`990 / PT day / model` とする。
内部上限は安全マージンであり、恒久値ではない。

Embedding APIを送信する直前に、その記事1件分を自前カウンタへ予約する。
requestを実際に送信した後は、timeoutや原因不明エラー等でAPI側の消費有無を断定できない場合も、安全側として原則カウンタを巻き戻さない。
request送信前に処理を中止した場合は消費予約しない。

自前 `used_today >= internal limit` の場合、そのモデルへEmbedding
APIを送らず、記事を単独Topicへフォールバックする。

内部上限に達する前でも、API側から明確なRPD quota
exhaustedが返った場合はAPI側を正とし、その時点で当該モデルをそのPT dayの
`quota_exhausted` 状態とする。
以後、そのモデル担当カテゴリの記事はEmbeddingせず単独Topicへフォールバックする。

429をすべてRPD使い切りとは扱わない。

-   RPD quota exhaustedと明確に判別できる429: そのモデルを当日quota
    exhaustedとする。
-   RPM / TPM制限:
    その記事だけEmbedding失敗としてsingletonへフォールバックし、日次quota
    exhaustedにはしない。
-   原因不明429 / capacity系:
    その記事だけsingletonへフォールバックし、日次quota
    exhaustedにはしない。

片方のEmbeddingモデルがquota
exhaustedでも、もう片方のモデルへ自動振替しない。

\*\*\

#### 8.6.15 V1パラメータは暫定値\*\*

次の値・割当はV1初期の暫定設定とする。

``` text
Gemma classification batch size: 1
Gemma classification timeout: 30秒
Gemma classification timeout retry: 最大1回（TimeoutError時のみ）
Gemma facts batch size: 1
Gemma facts retry: HTTP 500 / 502 / 503 / 504のみ最大3回（累積Stage 2 attempt最大4回）。429は即時retryせず既存queueで延期。
Gemma repetition detection: classification / facts両StageでJSON parse失敗確定前に適用
Thread title model: gemini-3.5-flash-lite
Thread title thinkingLevel: medium
Thread title batch size: 4 Topics固定
Thread title maxOutputTokens: 8192
Thread title timeout: 30秒
Thread title retry: HTTP 503のみ最大1回（1バッチ合計最大2 API要求）。`Retry-After` は最大60秒まで尊重し、各要求の4.1秒最小間隔・490/PT day内部quotaを予約時に適用。60秒超の待機、probe、quota停止、予約失敗の場合は再試行しない。HTTP 429、認証等の4xx、503以外のHTTP障害、通信エラーは再試行しない。
Thread title generation target: 47文字。超過時も採用し、監査ログへ記録
Thread title minimum request start interval: 4.1秒
Thread title internal RPD limit: 490 / PT day
Thread title reset probe interval: 5分以上
Facts item count limit: なし
Facts item length: 原則50文字前後（厳密上限なし）
Topic publish minimum facts: 1
Facts deduplication: trim + 空文字除外 + 完全一致のみ
Embedding dimensions: 384
Topic lookback: 24時間
candidate count: 1
Embedding 1 similarity threshold: 0.88
Embedding 2 similarity threshold: 0.88
Embedding 1 internal RPD limit: 990 / PT day
Embedding 2 internal RPD limit: 990 / PT day
Embedding reset probe interval: 5分
Topic worker schedule: 30秒間隔を基本候補
Topic worker max articles per run: 1
```

タイトル生成は4件固定batchとし、1〜3件の端数を時間flushしない。タイトル生成retryは0回固定とし、RPD節約を優先する。

カテゴリ→Embeddingモデルの初期割当も暫定値とし、一元設定する。

``` text
トレンド       -> Gemini Embedding 2
エンタメ       -> Gemini Embedding 2
サブカル       -> Gemini Embedding 1
マネー         -> Gemini Embedding 1
IT・ガジェット -> Gemini Embedding 1
```

これらをコード各所へ分散して固定しない。実運用のカテゴリ比率、Gemma分類latency、Geminiタイトル生成latency・thinking
token・RPD使用量、タイトル待ち件数、Topic worker滞留、Embedding
quota消費、similarity分布、誤統合・Topic分裂率を見て後から変更できる構造とする。

\*\*\

#### 8.6.16 V1の代表記事・カテゴリ・表示タイトル固定\*\*

同一Topicへ複数記事が集約された場合でも、V1ではTopicの代表記事、カテゴリ、確定後の
`thread_title` を後から変更しない。

-   最初にTopicを作成した記事を代表記事とする。
-   Topicの `category` は代表記事のGemma分類結果で固定する。
-   新規Topic本体はタイトル生成前に `thread_title = null`
    で作成してよい。
-   正常な `subject / event`
    を持ち、現在のfacts掲載基準を満たしたTopicだけをタイトル生成待ちへ追加し、4件揃った時点でGemini
    3.5 Flash-Liteへbatch送信する。
-   facts掲載基準を満たさないTopicはTopic本体とarticle-topic紐付けを保持したまま非公開とし、後続mergeで基準を満たした時点でタイトル生成待ちへ追加する。
-   47文字超過だけでは失敗にせず、タイトルを取得できたTopicは `thread_title`
    を後付け保存し、その後は再生成・差し替えしない。
-   既存Topicへmergeする記事ではタイトル生成を行わず、既存
    `thread_title` を維持する。
-   Gemma分類失敗で正常な `subject / event`
    を持たないsingletonはタイトル生成対象外とし、代表記事タイトルを表示用fallbackとして使用する。
-   Embedding失敗またはVector検索失敗でsingletonとなっても、正常な
    `subject / event` がある場合はタイトル生成対象としてよい。
-   タイトル生成に失敗した場合もTopic本体は維持し、`thread_title = null`
    のまま代表記事タイトルを表示用fallbackとして使用する。
-   Topic処理で完了した記事を10件蓄積するごとに、運営ニュース一覧キャッシュを1回更新する。カウントはinvocationをまたいで永続化し、10件未満では更新しない。
-   タイトル生成対象Topicは、タイトル生成成功または失敗確定後に一覧キャッシュへ反映する。
-   後続記事の分類結果が異なってもTopicを別カテゴリへ移動しない。
-   後続記事追加では代表記事のtitle、description、URL、sourceを差し替えない。

\*\*\

#### 8.6.17 V1で扱わない事項\*\*

関連Topic表示、parent / child Topic、続報チェーン、Topicの自動merge /
split、再クラスタリング、代表記事の自動差し替え、Topicカテゴリの再判定、Topic表示タイトルの自動再生成、Topic
Embeddingの再生成、失敗記事の自動再試行等はV1では仕様対象外とする。

加えて、次もV1では行わない。

-   quota切れを理由としたEmbedding 1 / 2間の自動モデル切替
-   quota切れ記事の後日再Embedding
-   reset pending中の記事の再処理
-   カテゴリ割当変更時の旧Topic一括再Embedding

**\#### 8.6.18 Embedding quota day・PTリセット・reset lag**

Gemini EmbeddingのRPD
reset基準は米国太平洋時間（PT）の午前0時として扱う。 固定UTC
offsetを使用せず、IANA timezone `America/Los_Angeles` を用いてquota
dayを判定する。 これによりPST/PDTのサマータイム切替へ自動追従する。

モデルごとにPT上の `YYYY-MM-DD` を `quota_day_pt` として管理する。

PTの日付が変わったことだけを理由に、API側quotaが即時復活したと断定しない。
API側リセットには反映ラグがあり得るため、前PT dayでquota
exhaustedを確認していたモデルは新PT day開始後にreset確認状態へ入る。

V1では概ね次のProbeを行う。

``` text
前PT dayでquota exhausted
↓
America/Los_Angeles上の日付変更
↓
新日でまだEmbedding成功なし
↓
Probe可能時刻なら1件だけEmbeddingを試す
↓
成功
  -> 新quota day開始を確定
  -> quota_day_ptを新日に更新
  -> used_todayはProbe分を含めて通常運用

明確なRPD quota exhausted
  -> reset未反映として待機継続

その他の一時失敗
  -> quota復活とは確定せず待機継続
```

Probe間隔のV1初期値は5分とする。

reset
pending中に到着した通常記事は待機queueへ長時間保持して後から再Embeddingせず、その記事は単独Topicへフォールバックする。
Probe対象となった記事も、Probeがquota系失敗した場合は単独Topicとして処理する。

新PT dayで最初のEmbedding成功を確認した時点で、前日のquota exhausted /
reset pending状態を解除する。

Embedding 1 / 2はそれぞれ独立してreset確認する。

**\## 9. RSS管理と定期巡回**

**\### 9.1 RSSタブ**

RSSはユーザー追加RSS専用の独立したRSSリーダー機能とする。

\* ニュース一覧のカテゴリタブ末尾に `RSS`
を表示し、登録済みRSSの記事を閲覧できる。

\* RSSの追加・削除・登録済みフィード管理は設定画面から行う。

\* ニュース一覧画面下部にはRSS管理用のナビゲーションを設けない。

\* 同一RSSはURLで識別する。

\* ユーザーが付けた個人用表示名は端末側へ保存し、共有しない。

\* RSS追加は `ensure-rss-feed` Edge Functionを経由する。

\* FlutterからUpstashへ直接書き込まない。

\*
RSS削除時は端末の登録一覧から除外し、RSSタブから対象RSSの記事を即時除外する。

\* 端末から削除しても、共有マスターやメタ情報を自動削除しない。

**\### 9.2 RSS共有状態**

RSS追加時は次を行う。

1\. `rss:urls` へ登録する。

2\. `rss:meta:<URL>` を登録またはマージ更新する。

3\. `rss:active` の最終利用時刻を現在時刻へ更新する。

メタ情報の更新では既存フィールドや未知フィールドを破壊しない。

**\### 9.3 ユーザーRSSの利用状態**

\* `rss:active` はSorted Setとする。

\* memberはRSS URL、scoreは最終利用日時のUnix timestampとする。

\* ユーザーRSSの利用判定期間は直近7日間とする。

\* ユーザーRSS読み込み後、1セッションに1回だけ `touch-rss-feeds`
を非同期実行する。

\* ユーザーRSSが0件なら通信しない。

\* touch失敗は起動やニュース表示を妨げない。

\* `touch-rss-feeds` は登録済みURLだけを受理し、1回最大100 URLとする。

\* ユーザーIDや閲覧記事履歴は保存しない。

7日以上利用されていないユーザーRSSは定期巡回対象から外すが、`rss:urls`、`rss:meta:<URL>`、`rss:active`
のmemberを直ちに物理削除しない。

再利用時はtouchまたは再追加によって自動復帰する。

**\### 9.4 RSSキャッシュ**

ユーザーRSSの記事キャッシュには `news:feed:<URL>` を使用する。

\* 値は記事オブジェクトのJSON配列とする。

\* ニュース本文や画像本体は保存しない。

\* 1RSSにつきURL重複除去、公開日時降順のうえ最大30件を保存する。

\* TTLは604800秒（7日）とする。

\* 利用されなくなったユーザーRSSのキャッシュはTTLで自然失効させる。

FlutterアプリにはUpstashの読み取り専用トークンだけを配置する。書き込み用トークンはEdge
FunctionのSecretsで管理する。

**\### 9.5 RSS定期巡回**

`update-news-cache` の巡回対象は、`rss:active`
のうち直近7日以内のユーザーRSSだけとする。

運営プリセットRSSは巡回対象へ含めない。`rss:presets`
は運営ニュース表示・定期巡回の正として使用しない。

\* 重複URLは1件として扱う。

\* 1実行につき最大30フィードを処理する。

\* 並行度は10とする。

\* 対象URLを安定した順序に並べ、カーソル方式で巡回する。

\* カーソルが対象件数の範囲外なら0へ正規化する。

\* 1フィードの取得・解析・保存失敗で他フィードの処理を止めない。

\* RSS取得だけでなくUpstash保存まで成功した場合に成功扱いとする。

\* Cronは15分間隔とする。

**\### 9.6 ニュースカードからのRSS探索・登録**

`RSS`
タブ以外のニュースカードでは、6.7の長押しメニューから記事配信元サイトのRSSを探索し、既存のユーザーRSSへ登録できる。

RSS探索はFlutterから配信元サイトへ直接総当たりせず、Supabase Edge
Function側で行う。RSS探索用の新規DBテーブルやSQLマイグレーションは使用しない。探索機能は発見・検証だけを担当し、実際の登録は既存のRSS追加経路を再利用する。

探索の起点は対象ニュースの元記事URLとし、HTTPリダイレクト後の最終到達URLを基準サイトとして扱う。探索順は次を基本とする。

1.  記事ページ内の `link rel="alternate"` 等からRSS / Atom /
    RDF候補を探す。
2.  サイトトップページで同様に候補を探す。
3.  候補がない場合のみ、少数の一般的なRSSパスを確認する。

無制限なURL総当たりは行わない。候補URLは正規化して重複除去し、実際に取得・解析してRSS
/ Atom /
RDFとして利用可能なものだけを候補とする。形式種別はユーザーへ表示しない。

外部URLへアクセスするEdge Functionでは、少なくともHTTP /
HTTPSだけを許可し、localhost、loopback、private
IP、link-local等へのアクセスを拒否するなどSSRF対策を行う。

探索中はBottomSheet内で `RSSを探しています…`
等の進行状態を表示し、ニュース一覧全体をローディング状態にしない。探索は長時間継続せず、全体として短時間で打ち切る。

探索結果は次のように扱う。

-   登録可能な候補が0件、探索失敗、候補検証失敗、登録失敗はいずれもユーザー向けには
    `RSSを登録できませんでした`
    と表示する。内部ログでは原因を区別してよい。
-   候補が1件だけで未登録なら、確認画面を挟まず即時登録する。
-   候補が複数なら候補選択UIを表示し、1件を選択して登録する。
-   候補一覧はFeedタイトルを基本表示とし、RSS / Atom /
    RDFの形式やURLは通常表示しない。タイトルを取得できない場合のみ、サイト名、NewsData.ioの
    `source_name`、ドメイン名、短縮URL等をフォールバック表示に使用できる。
-   既登録候補も複数候補一覧から除外せず、`登録済み`
    と表示して選択不可とする。
-   単数・複数を問わず、新たに登録可能な候補が1件もない場合は
    `このサイトのRSSは登録済みです` と表示する。

登録処理は既存のRSS追加処理を再利用し、`ensure-rss-feed`
を経由して端末のユーザーRSS一覧と共有RSS状態を更新する。新機能専用のRSS保存経路は作らない。既存RSS追加処理に初回記事取得が含まれる場合は、その処理も再利用する。

登録成功時は現在のニュース一覧に留まり、RSSタブへ自動遷移せず、画面下部から
`RSSに登録しました` と通知する。

ユーザーがRSS探索・候補選択用BottomSheetを閉じた場合は中断意思として扱う。まだ登録要求を開始しておらず処理を安全に巻き戻せる段階なら、その探索結果を破棄し、その後の成功・失敗・候補UIを表示しない。

すでに登録要求を送信した等、巻き戻せない段階まで進んでいる場合は処理を完了まで継続してよい。この場合はBottomSheetが閉じていても、登録成功時に画面下部から
`RSSに登録しました` と通知する。

この機能によってNewsData.io
APIを追加呼び出ししない。NewsData.io由来の記事では、一覧に既に存在する記事URL・配信元情報だけをRSS探索の入力として利用する。登録後の更新は既存RSS基盤で行う。

**\## 10. ニュース詳細**

ニュース詳細はAI速内のAI掲示板を本体とし、元記事は必要なときだけ開く。

基本表示は次とする。

\* ニュースカードの通常タップではAI速内のニュース詳細画面を開く。

\* 詳細画面のAppBarには記事タイトルを表示する。

\* AppBar直下に、配信元名を用いた `○○で読む ↗`
形式の元記事リンクを表示する。配信元名は右寄せとする。

\*
AIレスを読み進める（下方向スクロール）と元記事リンクは上方向へ収納され、逆方向（上方向スクロール）では再表示される。リスト最上部では必ず表示される。

\* 配信元名を独立したラベルとして重複表示しない。

\* 記事公開時刻は詳細画面へ独立表示しない。

\* NewsData.ioの `description`
はAI生成用コンテキストとして利用するが、詳細画面本文として表示しない。

\* `AI住人の反応`
等の見出しは置かず、元記事リンクの直後からAIレスを表示する。

\* 画面下部には通常の投稿UIを表示する。

第三者サイトの元記事をFlutter内WebViewへ埋め込まない。記事本文のWebView
DOM抽出も行わない。

元記事リンクを明示的にタップした場合はAndroidのPartial Custom
Tabを開く。

\* 対応環境では初期高さを画面のおおむね50%とする。

\* Partial Custom
Tabは高さ変更可能とし、最大化後に初期の部分表示へ戻せる。

\* 部分表示中は背面のAI速画面を操作可能とする。

\* 部分表示中はCustom Tab境界の直上右側に小さな投稿ボタンを表示する。

\* Custom Tabが最大化されている間は小さな投稿ボタンを表示しない。

\* 最大化から部分表示へ戻った場合は小さな投稿ボタンを再表示する。

\* 小さな投稿ボタンを押した場合は、Custom
Tabを閉じてAI速を前面へ戻した後、通常の投稿UIを開いてキーボード入力可能な状態にする。

\* AI速側AppBarの戻る操作を行った場合は、開いているCustom
Tabを閉じたうえでニュース詳細を閉じ、ニュース一覧へ戻る。

\* Custom
Tabが前面にある状態でAndroidのシステム戻る操作を行った場合は、Custom
Tabだけを閉じ、ニュース詳細は維持する。

\* Custom
Tabを開閉、最大化、部分表示へ復帰しても、同じニュース詳細画面が存続している間はAIレスの表示状態とスクロール位置を維持する。

\* Partial Custom Tab非対応環境では通常のCustom
Tab表示へのフォールバックを許容する。

\* Custom
Tab自体の起動に失敗した場合は、元記事を開けなかったことをユーザーへ通知する。

通常記事・保存記事とも、ニュース詳細を閉じて後から開き直した場合はレス表示位置を先頭から開始し、スクロール位置を永続保存しない。

**\## 11. AIレスデータ**

**\### 11.1 レスの出自**

レスの出自は次の3種類とする。

\`\`\`dart

enum ReplyOrigin {

  sharedAi,

  user,

  localAi,

}

\`\`\`

\* \`sharedAi\`:
全ユーザーで共有可能な通常AIレス。10件単位でSupabaseへ保存する。

\* \`user\`:
ユーザー本人の投稿。共有AIキャッシュへ保存しない。通常記事では端末内の表示系列だけに保持し、保存記事では19章に従って端末へ永続保存する。

\* \`localAi\`:
ユーザー投稿を起点としたAI返信。共有AIキャッシュへ保存しない。通常記事では端末内の表示系列だけに保持し、保存記事では19章に従って端末へ永続保存する。

\`user\` と \`localAi\` は通常の \`sharedAi\`
生成コンテキストへ含めない。

通報対象AIレスの保存は13.4に従う。

**\### 11.2 表示情報**

\* AI住人の基本表示名は \`名無しのAIさん\` とする。

\* AI住人に固定personalityを持たせない。

\* AI住人IDはアプリ側で生成・管理する。

\* 通常の \`sharedAi\` / \`localAi\` には新規ランダムIDを付ける。

\* \`\>\>AIレス\` への特定返信だけは対象AIレスのIDを継承する。

\* ユーザー自身のレスを対象にしても、ユーザーIDをAI住人へ継承しない。

\* 画面上のレス番号は \`sharedAi\`、\`user\`、\`localAi\`
を表示順に連番とする。

\* 広告と生成中表示はレス番号に含めない。

AIレスの基本表示はレス番号、名前、ID、本文とし、投稿時刻は表示しない。

**\### 11.3 レス操作**

各レスの既存操作はアクションボタンへ統合し、押すとBottomSheetを表示する。

\* AIレス（\`ReplyOrigin.sharedAi\` / \`ReplyOrigin.localAi\`）:
返信、コピー、通報。

\* ユーザー投稿（\`ReplyOrigin.user\`）:
返信、コピー、削除。通報は表示しない。

ユーザー投稿の削除では、削除実行前に確認ダイアログを表示する。

削除を確定した場合もレス自体は表示系列から取り除かず、レス番号および後続レスの番号を詰め直さない。本文だけを次の表示へ置き換える。

\`\`\`text

コメントを削除しました

\`\`\`

削除対象のユーザー投稿を起点として既に生成済みの \`localAi\`
は削除せず、そのまま残す。既存の \`\>\>N\` 参照関係も維持する。

保存記事では削除済み状態も19章に従って端末へ永続保存する。

返信操作の入力欄への挿入動作は15.3に従う。

**\### 11.4 AI生成レスの通報**

通報対象は \`ReplyOrigin.sharedAi\` と \`ReplyOrigin.localAi\`
のみとする。

\`ReplyOrigin.user\`、広告、AI生成中表示、エラー表示、その他レス以外のUIは通報できない。

通報理由の表示順、内部値、運営上の確認優先度は次のとおりとする。

\| 表示順 \| 通報理由 \| 内部値 \| 確認優先度 \|

\| --- \| --- \| --- \| --- \|

\| 1 \| 気に入らない・表示がおかしい \| \`dislike_or_display_issue\` \|
低 \|

\| 2 \| 攻撃的・危険な内容 \| \`harmful_or_abusive\` \| 高 \|

\| 3 \| 誤った内容 \| \`incorrect_content\` \| 中 \|

\| 4 \| その他 \| \`other\` \| 低 \|

「その他」選択時のみ補足入力欄を表示する。

\* プレースホルダーは灰色の \`任意\` とする。

\* 入力は任意とし、未入力でも送信できる。

\*
最大200文字（ユーザー認識上の文字単位、改行含む）とし、200文字を超える入力は打ち切る。

\*
入力欄付近に現在の文字数と上限を表示し、上限到達時には警告を表示する。

通報保存に成功した場合、そのセッション中は対象AIレスを通報済み表示へ切り替える。

通報済み表示:

\`\`\`text

コメントを通報しました

\`\`\`

通報済み状態では次のように扱う。

\* 画面本文は \`コメントを通報しました\` のみ表示する。

\* 元レスに \`\>\>N\`
が含まれていても、通報済み画面表示ではアンカーを表示しない。

\* コピー結果も \`コメントを通報しました\` のみとする。

\* コピー結果へ元の \`\>\>N\` や元AI本文を含めない。

\* 内部データには元のアンカー情報と元AI本文を保持する。

\* 再通報時は表示用の \`コメントを通報しました\`
ではなく、内部保持している元AI本文をDBへ送信する。

\* 通報済み表示のために元レスの内部データを破壊しない。

レス自体は削除しない。

通報済み表示状態は端末へ永続保存せず、アプリ再起動後は復元しない。

同じAIレスは通報済みでも何度でも通報できる。

保存と再通報時の更新は13.4に従う。

通報保存に失敗した場合は本文の差し替えを確定せず、掲示板閲覧や他操作まで失敗させない。

自動連続再送は行わない。

**\## 12. 共有AIチャンク**

**### 12.1 生成と共有**

* 1共有チャンクは `sharedAi` 10件とする。

* 基本はAI API 1回で10件を生成する。

* `chunk_index`
は共有AI系列上のチャンク番号であり、画面上の総レス数から算出しない。

* ユーザー投稿後も共有AI系列は継続する。

* 投稿そのものを理由に次の共有チャンクを取得・生成しない。

* 共有AIチャンク2以降のMISSでは、Flutterが記事URL、要求チャンク番号、会話パターン、既存の生成コンテキストをEdge Functionへ渡す。Edgeが要求を原子的にclaimし、チャンクの保存と採番を行う。Flutterは保存済みチャンクを読み直して表示し、同じ結果を再保存しない。
* 通常生成は14.1の優先順位を使う。通常Providerが7秒以内に確定失敗した場合は次順位へ進む。生成中のまま7秒に達した場合はその通信を中断せず、Google Gemmaを追加起動する。
* 最初に検証を通過した結果を要求チャンクとして保存してからFlutterへ返す。並行したもう一方が後から成功した場合、HTTP応答を待たせず `EdgeRuntime.waitUntil` で次の空きチャンクへ保存する。後続番号は原子的append RPCが決める。結果の保存順は生成順・Provider優先順位とは限らない。
  * 1生成要求の外部AI呼び出しは最大5回で、同一モデルをretryしない。全Providerで同一の生成プロンプトと会話コンテキストを使用し、10件を検証する。
  * quota関連処理は累計5秒、Function内の生成要求は40秒の期限を設ける。予約成功未確認・期限不足の場合はProviderを起動しない。
  * 通常モデル全候補の失敗・利用不可時はGoogle Gemmaを最大1回試す。両方が失敗した場合はHTTP 502と診断ID付き応答を返す。既存の原子的quota予約を維持する。
  * DBの要求leaseは最大60秒で、生成失敗後は明示的に解放し、Functionの異常終了時は期限後に再claimできる。遅延成功結果は同一要求ID・Providerの冪等キーでappendし、既存チャンクを上書きしない。

**\### 12.2 生成コンテキスト**

既存の後続共有チャンク生成には、直前最大3共有チャンク、最大30件の
`sharedAi` だけを過去レスコンテキストとして使用する。7秒時点で並行起動したProviderには、同一要求時点の同じ会話コンテキストと返信関係を渡す。後から保存される結果は、その同時生成時点で勝者のコメントを参照していない。

運営ニュースの正常Topicでは、ニュース情報として次をAIへ渡す。

``` text
thread_title
subject
event
facts[]
```

`thread_title`
は2ch/5ch風に生成された当該スレッドのタイトルとして扱い、生成レスはそのスレッドタイトルとニュース情報を踏まえて自然な掲示板の反応になるようにする。

`subject / event / facts` はTopicのニュース情報として扱う。`facts`
はその時点でTopicへ集約済みの最新配列を使用する。

Topicへ後続記事がmergeされて `facts`
が増えた場合でも、すでに生成・保存済みの共有AIチャンクは再生成しない。次に新しい共有AIチャンクを生成するときから最新の
`facts` を使用する。

Gemma分類失敗等により正常な `subject / event / facts`
を持たないsingletonでは、Topic
facts方式へ無理に変換せず、既存どおり代表記事の `title + description`
をニュース情報として使用する。

`user`、`localAi`、ユーザー投稿本文、ユーザー固有会話は共有AI生成コンテキストへ含めない。

**\### 12.3 共有AI内の会話関係**

\* 会話関係はアプリ側の \`ConversationPlan\` で決定する。

\*
会話グループは生成順・表示順・レス番号順を維持した連続位置だけで構成する。

\* 離れた位置同士を同じ会話グループにしない。

\*
パターンは独立レス、単独返信、複数の独立返信、3件チェーン、分岐、これらの混合を扱う。

\* 複数グループを作る場合、使用位置を重複させない。

\* チャンクをまたぐ会話関係は禁止する。

\* AIには各位置の役割だけを渡し、\`replyTo\` はアプリ側で付与する。

**\### 12.4 \`replyTo\`**

\* \`sharedAi\` 同士の \`replyTo\`
は、DB上では同一チャンク内の相対位置として保存する。

\* 画面へ追加する際に実際の表示レス番号へ変換する。

\* AIに \`replyTo\` や \`\>\>番号\` を生成させない。

**\## 13. Supabase AI共有キャッシュ・通報データ**

共有AIキャッシュには \`articles\` と \`thread_chunks\` を使用する。

AI生成レス通報には \`ai_reply_reports\` を使用する。

**\### 13.1 \`articles\`**

ニュースURLを記事識別キーとし、タイトル、作成・更新日時、最終アクセス日時等を保持する。

**\### 13.2 \`thread_chunks\`**

\* 記事、\`chunk_index\`、レス配列、更新日時等を保持する。

\* 1レコードは原則として \`sharedAi\` 10件とする。

\* 保存前に10件すべてが \`ReplyOrigin.sharedAi\` であることを確認する。

\* \`user\`、\`localAi\`、ユーザー固有の返信関係は保存しない。

**\### 13.3 読み書き**

\* DB HIT時は該当チャンクを再利用し、通常共有AI生成を行わない。

\* DB
MISS時、初回共有チャンクは14.5のサーバー側ルーターで生成・保存する。後続チャンクの既存取得・生成条件は維持する。

\*
DB取得エラー時も掲示板全体を停止させず、通常記事では必要に応じてAI生成へフォールバックする。

\*
保存記事では、次の共有AIチャンク生成またはユーザー投稿等でサーバー処理が必要になった時点でサーバー側の記事・スレッド状態を確認する。保存記事を開いただけでは生存確認のための追加通信を行わない。

\*
保存記事について、サーバー側の記事・スレッドが明確に存在しないことを確認した場合は新しいAI生成を行わず、19章の読み取り専用ローカルアーカイブへ移行する。

\*
timeout、通信不能、5xx等の一時的な取得失敗はサーバー側不存在として扱わず、保存記事を終了状態へ確定しない。

\* 同じ記事・同じ \`chunk_index\`
の二重READ、二重生成、二重追加、広告二重追加を防止する。

\* キャッシュ利用時は \`last_accessed_at\` を更新する。

**\### 13.4 AIレス通報DB**

通報にはSupabaseの専用テーブル \`ai_reply_reports\`
を使用し、既存AI共有キャッシュと分離する。

通報を理由に \`sharedAi\` や \`thread_chunks\` を自動削除・変更しない。

保存項目は次とする。

\`\`\`text

id

report_target_id

news_url

reply_text

report_type

note

updated_at

\`\`\`

\* \`report_type\` は11.4の通報理由の内部値とする。

\* \`note\` は「その他」の補足入力とする。

\*
画面上のレス番号、\`reply_origin\`、AIモデル名、\`priority\`、\`reason\`、管理状態、\`created_at\`、ユーザーID、端末IDは保存しない。

\* \`reply_text\`
には通報済み表示文言ではなく、元のAIレス本文を保存する。

\`report_target_id\`
は通報対象AIレスを一意に識別する安定IDとし、UNIQUE制約を設ける。

生成方式は実装依存だが、同じAIレスでは必ず同じ値になることを保証する。

\`sharedAi\`
は既存共有DB上の情報から特定可能な構造を利用でき、\`localAi\`
は必要に応じてUUID等の一意IDを持つ。

\`report_target_id\` を基準にupsertし、同じレスのレコードを上書きする。

再通報では少なくとも次を最新値へ更新する。

\`\`\`text

news_url

reply_text

report_type

note

updated_at

\`\`\`

最後に行われた通報内容を優先する。

通報履歴のレコードを増やさず、過去の通報理由・最高優先度・通報履歴は保持しない。

**\## 14. AI生成**

**### 14.1 現行モデルと返却形式**

* 共有AIチャンク2以降の通常モデルは、次の優先順位で順次選択する。`gemini-3.5-flash-lite` はこの経路に含めない。

  1. Groq: `openai/gpt-oss-120b`（`reasoning_effort: "low"`）
  2. Cloudflare: `@cf/google/gemma-4-26b-a4b-it`
  3. Google AI Studio: `gemini-3.1-flash-lite`
  4. OpenRouter: `nvidia/nemotron-3-ultra-550b-a55b:free`（Provider自動fallback禁止、prompt/completion価格上限0）

* 各通常モデルは利用可能モデルの順位で1つずつ開始する。7秒より前にHTTP/通信エラー、429、JSON解析または出力検証失敗が確定した場合は次順位へ進む。quota不足・cooldown中・Provider利用不可の場合はAPIを呼ばずスキップする。同一モデルをretryしない。
* 通常Providerが処理中のまま7秒に達した場合は通信を中断せず、通常Providerを継続しながらGoogle Gemmaを追加で1回起動する。Gemmaのquota予約に失敗した場合も通常Providerは継続する。両者の結果は独立して10件を検証し、最初に検証を通過した結果を要求チャンクとして保存する。
* Google Gemmaは `gemma-4-26b-a4b-it`、API timeout 6秒、`thinkingLevel: "MINIMAL"` とする。通常モデル全候補が確定失敗または利用不可の場合も最大1回起動する。並行起動した場合に後から成功した結果は破棄せず、元要求と同じ診断IDで次の空きチャンクへ保存する。Gemma終了後に通常順位へ戻らない。
* 全モデルの呼び出し前に、チャンク1と同じ設定・Redis scope・原子的quota予約を使用する。Google GemmaはFacts優先を維持する。予約成功を期限内に確認できなければAPIを呼ばない。timeout・結果不明の予約は取り消し・返金せず、保守的に消費を保持する。
* quota予約と429 cooldown処理は、生成要求全体で累計5秒の実経過時間予算を共有する。待機を含めて計上し、予算切れ後は新しいquota処理を開始しない。Redis通信自体の既存3秒timeoutも維持する。処理の中断後に届いた予約結果は採用しない。
* 40秒の内部期限は、claimからProvider処理、保存までを含む生成要求全体に適用する。通常の個別最長待機は30秒、Gemmaは6秒とし、必要な残り時間を確保できない新規Providerは起動しない。期限後の通信結果・DB結果は採用しない。
* quota予約・cooldown関連処理は累計5秒を上限とする。Flutterの45秒timeoutは維持するが、認証・入力受信、通信遅延、実行環境のスケジューリングを含む完了保証ではない。先着結果はDB保存完了後に返す。遅延結果は `EdgeRuntime.waitUntil` で元の40秒期限内に保存するが、Edge Runtimeの停止時まで含めた完了保証はない。
* 全Providerに同じ生成プロンプト・過去チャンク・返信関係を渡す。既存JSON補正を使い、10件の有効な文字列を厳密に検証する。診断IDを共通利用し、モデル別のHTTP status、経過時間、検証結果、切り替え理由、quota時間切れ、内部期限終了を安全な診断ログへ記録する。
* 通常投稿への返信および特定AI住人への返信は `gemini-3.5-flash-lite`（最大30秒待機、fallbackなし）を維持する。タイトル生成のGemini 3.5割当とチャンク1専用ルーター（14.5）は変更しない。

* AIにはレス本文だけをJSON文字列配列で返させる。

```json
[
  "レス本文1",
  "レス本文2"
]
```

AIにレス番号、名前、ID、`replyTo`、`>>番号`、日時、広告情報、`chunk_index`
を出力させない。

**### 14.1.1 AI生成の通信経路と責務**

AI生成はSupabase Edge Functionを唯一のAI
Provider通信窓口とする。Flutterは生成に必要な構造化データをEdge
Functionへ渡し、完成済みのProvider向けプロンプトやAI
ProviderのAPIキーを保持・送信しない。

Edge
Functionは生成モードに応じてプロンプトを構築し、サーバー側で定めたAI
Provider、モデル、Provider固有設定（共有AIチャンク2以降の通常4モデル、7秒時点でのGoogle Gemma並行起動を含む）を使用してAI
APIを呼び出す。FlutterからAI
Providerや任意モデルを指定して切り替える構造にはしない。

Edge
FunctionからFlutterへ返す生成結果は、アプリが必要とするAIレス本文、確定チャンク番号と安全な結果情報に限定する。AI
Providerの生レスポンス、生エラー、認証情報、秘密情報は返さない。

`sharedAi` のチャンク1生成は14.5に従う。チャンク2以降は `articleUrl`、`chunkIndex`、`conversationPattern` を含む要求だけを新しいサーバー保存経路へ送り、DBのclaim・生成・保存・原子的採番をEdgeが行う。旧Flutterからのメタデータなし要求は従来の応答形式を維持する。新経路のFlutterは保存済みチャンクを再読込・表示し、再保存しない。通常投稿への返信と特定AI住人への返信の既存の責務は変更しない。

通常投稿への返信および特定AI住人への返信でも同じEdge
Function経路を使用し、ユーザー固有の `localAi`
を共有キャッシュへ保存しない既存仕様を維持する。

**\### 14.2 プロンプト**

プロンプトは固定性の高い情報を前方、リクエストごとの可変情報を後方へ置く。

正常な運営Topicでは、ニュースコンテキストとして
`thread_title / subject / event / facts[]`
を使用する。Gemma分類失敗等で正常なTopic情報を持たないsingletonでは、既存どおり代表記事の
`title + description` を使用する。

正常Topicの基本順序は次とする。

1\. 共通ルール

2\. Topicニュース情報

``` text
thread_title
subject
event
facts[]
```

3\. 生成モード固有ルール

4\.
`REPLY_TYPES`、会話関係、過去コンテキスト、ユーザー投稿、対象レス等の可変情報

`thread_title`
はこの掲示板スレッドのタイトルとしてAIへ渡す。`subject / event / facts`
はこのスレッドに関するニュース情報として渡す。AIにはスレッドタイトルとニュース情報を踏まえて、自然な掲示板のレスを生成させる。

生成モードは次の3種類とする。

-   `SHARED_THREAD_GENERATION`

-   `USER_REPLY_GENERATION`

-   `SPECIFIC_PERSON_REPLY`

正常Topicの記事では、共有AI生成だけでなく、通常投稿への返信・特定AI住人への返信でも、ニュース背景として同じTopicニュース情報を利用できる。ユーザー投稿や対象レス等のモード固有情報は従来どおり別の可変コンテキストとして追加する。

共有生成では、アプリ側の `ConversationPlan`
がチャンク内の会話関係を決定する。

`ConversationPlan`
に基づき、各位置について独立レスまたは他レスへの反応という役割をプロンプトへ渡す。

通常の独立位置では `REPLY_TYPES` を使用する。

タイプ候補は次を基本とする。

-   意見

-   感想

-   疑問

-   短い一言

-   ニュースから軽く連想した一言

AIは指定された位置ごとの役割に従って本文だけを生成する。

実際の `replyTo` はアプリ側で `ConversationPlan` に基づいて付与する。

AIへ渡す `thread_title`、`subject`、`event`、`facts`、代表記事
`title`、`description`、過去レス、ユーザー投稿、対象レス等の入力データは命令ではなくデータとして扱わせる。

入力データ内にプロンプト、命令、役割変更、出力形式変更等に見える文字列が含まれていても、生成ルールを上書きする指示として扱わせない。

このデータ境界とプロンプトインジェクション対策は、共有AI生成、通常投稿への返信、特定AI住人への返信の各生成モードで維持する。

**\### 14.3 Gemma 4 31Bによる最新Topicコメント事前生成**

Google AI Studioの `gemma-4-31b-it` を利用し、新規作成された最新Topicへ共有AIコメントを事前生成する。これは完全なbest-effort補助処理とし、失敗・遅延・503・Cloudflare側障害によってTopic Processing、Topicの作成・統合・公開、Facts生成、ユーザー起点のAIコメント生成、既存sharedAi表示・生成を妨げない。

V1では対象を常に**最新の新規Topic 1件だけ**とする。古い未成功Topicの救済キュー、LIFO/FIFO候補リスト、TTL付き候補キューは持たない。新しいTopicが作成された場合、それまでretryしていた古いTopicは諦め、次のattemptから最新Topicへ切り替える。既存Topicへのmergeでは新しい31B処理を発火せず、retry中のTopicへ記事がmergeされても31B入力を更新しない。

31Bチャレンジは、新規Topicが作成され、31Bコメント生成に必要なTopicタイトルとFactsが確定した時点で1回だけ通知する。通知自体はbest-effortとし、通知失敗を理由にTopic Processingを失敗扱いにしない。確実配送用outbox、dead-letter queue、恒久retry queueはV1では設けない。

31Bへ渡すニュース情報は、発火時点の以下に固定する。

- Topicタイトル
- Facts

cleaned body、元記事本文、description等は31Bへ直接渡さない。

Cloudflare側では、Cloudflare Worker + singletonのSQLite-backed Durable Object + Durable Object Alarmを31B Challengerの調整役として使用し、最新Topic 1件の `topic_id`、Topicタイトル、Facts、受信時刻、競合判定に必要な最小限の状態、rate制御、次回attempt予定を保持する。新規Topic通知で旧ターゲットを上書きする。旧Topicについて送信済みの31Bリクエストを必ずしも強制キャンセルする必要はないが、遅れて返った旧結果による不正な二重保存を防ぐ。

Topic ProcessingからCloudflareの専用endpointへ、必要最小限の `topic_id`、Topicタイトル、Factsをbest-effort POSTする。endpointは公開無認証にせず、Supabase側とCloudflare側に通知専用secretを保持してAuthorization header等で検証する。Google API keyを通知payloadへ含めず、API key・secret等の認証情報をログへ出力しない。

Google APIがHTTPエラーを返した場合、CloudflareはJSONの`error.message`のみを診断情報として取得し、最大400文字に制限して秘密情報を除去したうえでDurable Objectへ保存する。エラー本文全体や、request body・Topicタイトル・Facts・生成コメント・認証情報は保存・Operations Dashboardへ表示しない。認証済み`/internal/status`とローカルOperations DashboardではHTTP statusと安全化済みエラーメッセージを確認できる。この診断情報は既存のHTTP別retry判定・間隔・Topic切替・コメント保存処理を変更しない。

31B呼び出しは以下を基本とする。

- Provider: Google AI Studio
- Model: `gemma-4-31b-it`
- Streamingを使用する。
- Thinkingは `minimal` を使用する。
- コメント生成件数、プロンプト、parser、番号・名前・ID・`replyTo`・`ConversationPlan`・表示順は既存sharedAi仕様と整合させる。
- 正常系でもTTFTが30秒を超える実測があるため、30秒timeoutを前提としない。

503 / UNAVAILABLEは再試行対象とする。V1のアプリ内部制限は**最大10 attempts / 任意の60秒窓**とし、503時は短い待機+jitterを許可する。429は即時連打せずrate limit windowを考慮して停止する。400系、parser failure等の非一時的失敗を同一入力で無限retryしない。Google側の実quotaは `docs/EXTERNAL_LIMITS.md` と実アカウントの最新表示・API応答を正とし、外部quota値を本仕様へ固定しない。

31Bコメント生成が成功した場合、次の31B生成開始まで**最低60秒**のcooldownを設ける。cooldown中に複数の新規Topicが作成された場合、cooldown終了時点の最新Topicだけを対象とする。

31BとFacts生成側のGemma 4 26Bは役割と失敗系統を分離する。31Bの503、停止、rate limitによって26BのFacts処理を停止・遅延させない。

31Bの高頻度retryをSupabase・Upstashへ伝播させない。31B attemptごとにSupabase Edge Functionをinvokeしたり、DBからTopicを読み直したり、Upstashへ候補Topicを問い合わせたりしない。TopicタイトルとFactsはCloudflare通知時に渡し、retry中はCloudflare側で同じ入力を利用する。Cron、Cloudflare KV、Upstashを高頻度retry制御のために追加利用しない。

31Bと通常の無料AIルーターが同じTopicで並行して成功した場合は、共通の原子的な保存処理で、先に保存に成功した結果をチャンク1、後から成功した結果をチャンク2以降に割り当てる。31Bの結果が遅れても、同一Topicの有効な生成結果であればチャンク1の存在だけを理由に破棄しない。既存チャンクの上書き、同一試行の二重保存、チャンク番号の衝突は禁止する。旧ターゲット等、31B側で既に無効となった結果の扱いは従来の世代判定を維持する。

31Bの結果が保存された場合は、ユーザーが該当チャンクを取得した際に既存sharedAiコメントとして利用する。保存形式は既存のSupabase `articles` / `thread_chunks` とsharedAi仕様へ合わせ、31B専用形式を安易に新設しない。

以下は31B事前生成の正常な縮退動作として扱い、Topic・Facts・通常コメント生成を継続する。

- 31Bが503を返し続ける。
- 31Bが長時間生成を開始しない。
- Cloudflare通知に失敗する。
- 31Bコメントを生成できないまま新Topicへ切り替わる。

V1では、Topic候補のLIFO/FIFOキュー、古いTopicの救済、31B失敗Topicの恒久retry queue、Topic merge時の31B入力更新、成功済みTopicのmergeによる31B再生成、Upstashを使ったattempt単位の状態管理、全Topicを31Bで確実に処理する保証は実装しない。必要性が実測で確認された場合のみV2以降で検討する。

**\### 14.5 無料AI共有チャンクルーター V1**

本節は共有AIチャンクの初回生成を対象とする。通常投稿への返信・特定AI住人への返信は既存経路を維持する。既にチャンク1が存在するTopicではルーターを起動しない。チャンク2以降の閲覧・取得は既存のスクロール契機を維持し、ルーターによる先行保存だけを理由に画面へ自動追加しない。

通常モデルの選択順位は次のとおりとする。

1. Groq GPT-OSS 120B
2. Cloudflare Gemma 4 26B
3. Gemini 3.1 Flash-Lite
4. OpenRouter Nemotron 3 Ultra（free）

Google AI Studio Gemma 4 26Bは、Facts生成を優先する特別な並列候補とする。Facts生成の待機・実行分を優先し、共通RPM・TPMに余裕があるときだけコメント生成へ参加する。余裕がなければ待たずに通常順位の次の利用可能モデルを選ぶ。Google Gemma 4 26Bのコメント生成はアプリ内部で最大10,000リクエスト/日とし、Facts生成用に4,400リクエスト/日を残す。実際のProvider quotaと共有範囲は `docs/EXTERNAL_LIMITS.md` および実測・Provider応答に従う。内部割当はProvider側の独立quotaを意味しない。

初回は利用可能な2モデルを同時起動する。通常はGroqとGoogle Gemma 4 26Bを選び、Googleが参加できない場合はGroqとCloudflare等の次候補を選ぶ。Groqが利用できない場合も、通常順位とGoogleの参加条件に従う。同一Topicで同じモデルを重複起動しない。

チャンク1が未完成で、実行中の全モデルが起動から3秒以上経過しても成功していない場合は、次の利用可能な無料モデルを追加起動する。実行中の全モデルが失敗した場合は、3秒を待たずに次候補を起動できる。モデルの失敗時に他の実行中モデルが3秒未満なら、そのモデルの3秒到達を待つ。チャンク1完成後は、追加モデルを起動しない。既に起動したモデルは閲覧者の有無やチャンク1完成にかかわらず処理を継続し、成功結果を保存する。成功結果は10件のコメントとして検証する。モデルごとのチャンク間の会話連続性は要求しない。

生成結果は31B事前生成と共通の原子的保存処理を使い、保存成功順にチャンク1、2、3以降を割り当てる。並列保存時の番号衝突と同一試行の二重保存を防止する。31Bが先にチャンク1を保存した場合は、通常ルーターの新規起動を行わない。通常ルーターの起動済みモデルや31Bの有効な実行中リクエストは、後から成功した場合もチャンク2以降に保存する。

Supabase DBでTopic単位の生成ジョブとモデル試行状態を管理し、複数閲覧者からの二重起動を防ぐ。Supabase Edge Functionの `EdgeRuntime.waitUntil` を利用してHTTP応答後も起動済みモデルを処理する簡易構成とし、V1ではSupabase Queues等の永続実行キューを追加しない。`waitUntil` は完了保証ではないため、実行環境の停止で未受信結果が失われる場合がある。期限切れジョブは次のアクセス時に復旧可能とするが、結果不明の送信済みリクエストを無条件に再送しない。保存済み結果は維持する。

閲覧者の入退室通知、presence、生存通知、離脱による生成停止はV1では実装しない。チャンク1完成後の追加起動停止だけを行う。

全Topic共通のUpstash Redisレートリミッターで、実際のProvider・モデル・APIキー間のquota共有範囲に応じてRPM・TPM・日次上限を原子的に管理する。GoogleのFacts生成とコメント生成は共通使用量を管理し、Facts生成を優先する。利用枠が足りないモデルは待たずにスキップする。429は補助的な制限検知とし、Providerのリセット情報等に応じてcooldownを設定する。外部API・Redisの利用量は `docs/EXTERNAL_LIMITS.md` の該当サービスの制限を守る。

有料モデルへのフォールバックはV1の対象外とし、有料APIを自動起動しない。

**\### 14.4 JSON解析**

1\. まず返却値をそのまま \`jsonDecode\` する。

2\.
失敗した場合だけ、JSON文字列内部の生LF、CR、Tabをエスケープして再解析する。

3\. 正常なJSONや既存のエスケープ文字は変更しない。

4\. 補正後も失敗した場合は既存エラー処理へ進む。

5\. JSON解析失敗だけを理由に同じモデルをretryしない。共有AIチャンク2以降では14.1に従って次候補へ切り替える。

6\. デコード後の本文の改行、引用、複数文は保持する。

**\## 15. ユーザー投稿とlocalAi**

**\### 15.1 投稿位置と即時表示**

\*
ユーザー投稿は、現在見ている位置にかかわらず、現在読み込み済みのレス系列末尾へ追加する。

\* 投稿を理由に次の共有AIチャンクを強制取得しない。

\* AI返信を待たず、\`user\` レスを即時表示する。

\* 表示直後に新規 \`user\` レスへ自動ジャンプする。

\* AI生成に失敗しても、先に表示した \`user\` レスは削除しない。

\* AI返信が必要な場合だけ、\`localAi\` を非同期生成する。

\* 生成状態はユーザー投稿ごとに独立して管理する。

**\### 15.2 通常投稿**

通常投稿には \`localAi\` を2〜3件生成する。

完成した \`localAi\` は対応するユーザー投稿のブロックへ追加する。

**\### 15.3 \`\>\>番号\` 投稿**

\* 投稿本文から \`\>\>N\` を解析し、表示中の対象レスを解決する。

\*
対象レス本文とユーザー投稿本文を返信生成に必要なコンテキストとしてAIへ渡す。

\* \`replyTo\`
はアプリ側で対象レスとの関係を管理し、AIには生成させない。

\* 各レスの返信操作から、入力欄のカーソル位置へ \`\>\>対象番号\`
を挿入できる。

対象がAIレスの場合:

\* 対象AIレスのIDはAIへ渡さない。

\* 生成後にアプリ側で対象AIレスと同じIDを返信へ付与する。

\* 同じAI住人が返答したように表示する。

対象がユーザー自身のレスの場合:

\* ユーザーのIDをAI住人へ継承しない。

\* 生成される \`localAi\` には通常の新規AI住人IDを付与する。

AI返信対象である場合の生成件数は、通常投稿と同様に2〜3件を基本とする。

ただし特定AI住人への返信など、生成モード固有の件数指定がある場合はそのルールを優先する。

**\### 15.4 低情報投稿**

単独で反応材料がほぼない投稿は、\`user\`
として表示するがAI返信を生成しない。

対象には、1文字だけの投稿、同一文字の連続、\`?\`、\`？？？\`、\`w\`、\`www\`、\`草\`
等を含む。

アンカーだけの投稿もAI返信を生成しない。

\`\`\`text

\>\>11

\`\`\`

ただし、アンカーによって対象が明確な質問はAI返信対象とする。

\`\`\`text

\>\>11 ?

\>\>11 なんで？

\`\`\`

アンカーなしの低情報投稿では、AI返信だけでなく共有AIの補充生成も行わない。

**\### 15.5 表示順**

AI返信対象の投稿直後は次の順で表示する。

\`\`\`text

user

投稿直後広告

AI返信生成中表示

\`\`\`

生成完了後は次の順とする。

\`\`\`text

user

投稿直後広告

localAi 2〜3件

\`\`\`

AI返信不要投稿は \`user\` と投稿直後広告まで表示する。

投稿直後広告はAI返信完成後も位置を移動しない。

ただし投稿直後広告は、18.4の広告配置条件を満たす場合だけ表示する。

**\### 15.6 生成中メッセージ**

\*
生成中メッセージは、共有AI生成、通常投稿への返信、特定AI住人への返信の3系統に分ける。

\*
各系統の候補から生成開始時に1件を選び、同じ生成処理が完了するまで表示文言を固定する。

\* Widgetの再buildだけを理由に文言を変更しない。

**\### 15.7 AI返信生成中の投稿操作**

AI返信生成中は、新しい投稿を送信できない。

送信できない間は次の状態とする。

\* 送信ボタンを無効表示にする。

\* AI返信生成中であることと、完了後に送信できることを表示する。

\* 入力中の文章は保持する。

\* 無効な送信操作で入力欄を閉じたり、入力内容を削除したりしない。

AI生成の完了、失敗またはタイムアウト後は状態に応じて再び送信可能とする。

**### 15.8 AI返信生成失敗**

AI返信生成に失敗した場合は生成中表示を終了し、失敗状態と再試行操作を表示する。

* 自動的な連続再試行は行わない。

* ユーザーが再試行を選択した場合だけ再要求する。

* AI通信が30秒以内に完了しない場合はタイムアウトとして扱う（通常投稿への返信および特定AI住人への返信ではGemmaフォールバックを行わない）。

* 先に表示済みの `user` レスは削除しない。

* エラー終了時も生成中状態を確実に解除する。

**\### 15.9 文字数制限**

\* 投稿本文は最大200文字（ユーザー認識上の文字単位）とする。

\* 改行も1文字として数える。

\* \`\>\>番号\`
を含む投稿も、アンカー部分を含めて全文で200文字以内とする。

\*
キーボード入力および貼り付けにおいて、200文字を超える分は自動的に打ち切る。

\* 入力欄付近に現在の文字数と上限（例: \`84 / 200\`）を表示する。

\* 上限到達時には「200文字まで入力できます」という警告をUI上に表示する。

\*
投稿送信時にも文字数バリデーションを行い、200文字を超える場合は送信を拒否する。

\*
バリデーションにより送信拒否された場合、入力欄の内容は削除せず保持する。

**\## 16. アンカージャンプ**

**\### 16.1 \`\>\>N\` タップ**

\* 表示中の \`\>\>N\` をタップするとN番レスへジャンプする。

\*
この場合だけ、アンカーが書かれていた元レスを1件の戻り先として保持する。

\* 対象レスへ移動後は \`↩ N番へ戻る\` を表示できる。

\* 戻り履歴は1段階だけとし、Androidのシステム戻るとは分離する。

\*
ユーザー投稿では、アンカー直後の空白・改行と本文の位置関係を入力どおりに表示する。

**\### 16.2 投稿後ジャンプ**

\* アンカーの有無にかかわらず、自分の新規投稿へジャンプする。

\* 投稿後ジャンプでは戻り先を設定しない。

\* 元レスへ戻りたい場合は、自分の投稿本文内の \`\>\>N\` をタップする。

\*
自動ジャンプ終了後は、手動操作がない状態で末尾補正によって表示位置を変更しない。

**\### 16.3 未buildレス**

対象レスが未buildの場合は、概算位置へ移動して対象Widgetをbuildさせ、フレーム完了後に
\`Scrollable.ensureVisible\` で正確に位置合わせする。

投稿後ジャンプ、アンカージャンプ、戻り、準備用移動、\`ensureVisible\`
はプログラムジャンプとして扱い、次チャンク取得を発火させない。

**\## 17. AI掲示板の無限スクロール**

**\### 17.1 追加取得**

\*
次の共有AIチャンクは、実ユーザーの下方向スクロール操作だけを契機に取得する。

\* 通常スクロールでは末尾約200px以内を取得トリガーとする。

\* 物理末尾では、下端方向への \`OverscrollNotification\`
を取得トリガーにする。

\*
Overscrollは実ユーザードラッグで、プログラムジャンプ中でなく、読み込み・生成中でない場合だけ受理する。

\* \`itemBuilder\` やWidgetのbuildを取得トリガーにしない。

\*
通常スクロールとOverscrollが近接しても、同一チャンクを二重取得しない。

\* 投稿自体を次チャンク取得トリガーにしない。

**### 17.2 追加取得失敗**

次の共有AIチャンクの取得または生成に失敗した場合は、既存レスを維持したまま追加読み込み状態を終了する。

* 追加取得失敗メッセージをユーザーに表示する。
  * 共有AIチャンク生成失敗時は、以下の15種類のメッセージからランダムに1つ選択して表示する。
    1. このスレッドは過疎っているようです…
    2. どうやら住民たちはお休み中のようです。
    3. ただいま住民の姿が見当たりません。
    4. 住民たちは少し席を外しているようです。
    5. このスレッドは現在、静まり返っています。
    6. どうやら住民たちは休憩中のようです。
    7. ただいまレスが途絶えているようです。
    8. 住民たちは現在、行方不明のようです。
    9. このスレッドには静かな時間が流れています。
    10. どうやら住民たちは留守のようです。
    11. どうやら住民たちはROMっているようです…
    12. ただいまROM専の住民しかいないようです。
    13. 住民たちは静かにスレッドを見守っています。
    14. どうやら全員ROMモードに入ったようです。
    15. 書き込む住民が現れるのを待っています…
  * 選択されたメッセージは再描画やスクロール操作で変化せず維持する。
  * 正常に生成された場合はエラーメッセージを消去する。
* 再試行操作を表示する。
  * 再試行ボタンの文言は「住民を呼び戻す」とする。
  * 再試行ボタンをタップして再び失敗した場合は、15種類から改めて抽選する。
* 自動的な連続再試行は行わない。
* ユーザーが再試行した場合だけ、失敗した次チャンクの取得を再実行する。
* 失敗によって既存の表示済みレスを削除しない。
* 再試行時も同一チャンクの二重取得・二重追加を防止する。

**\## 18. 広告**

**\### 18.1 共通方針**

\* 広告SDKはGoogle Mobile Ads SDK（AdMob）を使用する。

\* 全画面広告、インタースティシャル広告、リワード広告は使用しない。

\* ニュース一覧およびAI掲示板ではNative広告を使用する。ニュース一覧の固定下部バナー広告は使用しない（撤去済み）。

\* Native広告はGoogle AdMob公式の最新要件を優先して実装する。

\* 広告帰属表示はGoogle公式要件を満たす文言・サイズとし、基本表示は
\`【広告】\` とする。

\* AdChoicesを常に視認可能な位置へ表示する。

\* headline等、Google公式仕様上表示が必要なNative
assetは要件に従って表示する。

\* \`body\`、\`callToAction\`、\`advertiser\`、\`icon\` 等のoptional
assetは存在する場合だけ表示し、存在しない場合は空文字・空欄を残さず対応Viewを非表示（Androidでは
\`GONE\` 相当）とする。

\* Native広告のmain image / videoを表示する場合は \`MediaView\`
を使用し, main imageを独自 \`ImageView\` へ置き換えない。

\*
Native広告上へ独自の全面GestureDetector等を重ねず、広告assetのクリック処理はGoogle
Mobile Ads SDKへ委ねる。

\* テスト広告ではNative
Validatorを有効にし、広告帰属表示、AdChoices、asset配置等を確認する。

\*
アプリ独自UI要件とGoogle公式広告要件が競合する場合はGoogle公式要件を優先する。

**\### 18.2 ニュース一覧固定バナー（撤去済み）**

ニュース一覧画面下部の固定バナー広告（Anchored Adaptive Banner）およびその広告専用の余白（1dp非クリック境界線、3dp非クリック余白）は撤去済みであり、表示処理を行わない。

縦方向の基本構成は次とする。

\`\`\`text

ニュース一覧

AndroidのSafeArea / システムナビゲーション領域

\`\`\`

ニュース一覧画面にはアプリ独自の下部ナビゲーションバーを設けない。
保存ニュースとRSS登録・管理への導線は設定画面に置く。

**\### 18.3 ニュース一覧Native広告**

配置は各カテゴリごとに次のルールとする。

\`\`\`text

カテゴリ先頭にNative広告

ニュース1〜10

Native広告

ニュース11〜20

Native広告

...

\`\`\`

\* カテゴリ先頭に1枠置き、その後ニュース10件ごとに1枠置く。

\*
カテゴリを切り替えた場合も、そのカテゴリの先頭から同じ配置ルールを適用する。

\* Native広告カードは通常ニュースカード82dpとは別の専用固定高とする。

\*
約140dpを基準とし、Google公式要件、120×120dp以上のMediaView、広告帰属表示、AdChoices、テキスト、paddingを適切に収めるため数dp程度の調整を許容する。

\* 右側に120×120dp以上の \`MediaView\` を確保し、静止画・動画のmain
media assetを表示可能な構成とする。

\* 左側には広告帰属表示、headline、利用可能なoptional assetを配置する。

\*
AdChoicesは右上を基本候補とし、MediaViewやテキストに隠れない視認可能な位置を確保する。

\* 通常ニュースの保存マーク等、記事固有の操作UIは広告へ付けない。

基本イメージ:

\`\`\`text

┌────────────────────────────────────┐

│【広告】 広告主          ┌─────────┐│

│ headline               │AdChoices││

│ headline / body        │         ││

│ CTA                    │MediaView││

│                        │120×120  ││

│                        │         ││

│                        └─────────┘│

└────────────────────────────────────┘

\`\`\`

**\#### 18.3.1 ロードと予約領域**

\*
広告予定位置には最初からNative広告カードと同じ高さの非クリック予約領域を確保する。

\* カテゴリ先頭広告はカテゴリ選択時に即時ロードする。

\*
10件間隔広告は、広告位置がおおむね現在のviewport約1画面分手前まで近づいた時点でロードする。

\* 「1画面」は固定pxではなく現在のviewport高さを基準にする。

\*
高速スクロールで広告位置へ先に到達しても、予約領域を維持したままロード完了を待つ。

\* 1広告枠につきロード要求は原則1回だけとし、Widget
rebuild、setState、スクロールアウト後の再表示では再ロードしない。

\* ロード中の予約領域はクリック不可とし、ダミー広告や独自CTAを置かない。

\*
ロード失敗時は、そのカテゴリを表示している間は同じ高さの空・非クリック予約領域を維持し、後続ニュースを上へ詰めない。

\* ロード失敗メッセージは表示せず、同じ広告枠では自動再試行しない。

\*
選択中カテゴリのNative広告だけを保持し、カテゴリを離れた時点でそのカテゴリのNative広告インスタンスをdisposeする。

\*
同じカテゴリへ戻った場合は、新しい広告枠・新しい広告インスタンスとして新規ロードしてよい。

\* 1つの物理広告インスタンスを複数の広告枠で再利用しない。

**\### 18.4 AI掲示板Native広告**

\* AI掲示板の広告位置判定には \`ReplyAdPolicy\` を使用する。

\* コメント欄の一番上（コメント1件目の前）に先頭ネイティブ広告を1枠表示する。

\* placementは \`normalComment\` と \`postContribution\`
を内部的に区別する。

\* 通常は \`sharedAi\` 10件ごとの広告機会を基本とする。

\* ユーザー投稿では、直近10レス以内に広告がない等、既存
\`ReplyAdPolicy\` の条件を満たす場合に \`postContribution\`
をuser直後へ配置する。

\* 毎回の投稿で無条件に広告を追加しない。

\* 同じブロック内で \`normalComment\` と \`postContribution\`
を二重表示しない。

\* 投稿直後広告は \`localAi\` の生成完了後も位置を移動しない。

\* 広告はレスデータと分離し、Supabaseの \`thread_chunks\` へ保存しない。

\*
広告のロード成功時に、広告表示成功を知らせるデバッグ用Popup、Dialog、Snackbar等を表示しない。広告の配置、ロード、impression計測、収益計測、失敗時ログ等の既存広告処理はこのUI非表示を理由に変更しない。

掲示板Native広告はレスUIに合わせたテキスト主体の可変高レイアウトとする。

\`\`\`text

【広告】 headline                 AdChoices

body

CTA →  （提供される場合）

\`\`\`

\*
おおむね2〜4行程度を目安とするが、Google公式要件と提供assetを優先する。

\* ニュース一覧用の120×120dp MediaViewを掲示板へ無理に導入しない。

\* optional
assetが存在しない場合は対応Viewを非表示にし、空欄を残さない。

**\#### 18.4.1 投稿時のnormalComment置換**

\* ユーザー投稿時、既存 \`ReplyAdPolicy\`
上の置換対象で、かつ一度もviewportへ入っていない \`normalComment\`
だけを \`postContribution\` へ置換できる。

\* 「見た広告」の判定はAdMob
impressionではなく、広告Widgetがviewportへ一度でも入ったこととする。

\* viewportへ一度でも入った広告は保護し、投稿時に削除・置換しない。

\* 内部状態は \`hasEnteredViewport\` 等、AdMob
impressionと混同しない名称で管理する。

\* 置換時は元 \`normalComment\`
の広告インスタンスをdisposeし、\`postContribution\`
用の新しい広告インスタンスを生成・ロードする。

\* 置換前後で同じ物理広告インスタンスを再利用しない。

**\#### 18.4.2 ロード失敗**

\* 掲示板Native広告は1広告枠につきロード要求1回を基本とする。

\* ロード中枠はクリック不可とする。

\* ロード成功時だけNative広告を表示する。

\* ロード失敗時は広告枠自体を削除し、空白を残さない。

\*
高速スクロール等でロード中枠がviewportへ入った後に失敗した場合も削除する。

\* 同じ広告枠では自動再試行しない。

\* ロード失敗した広告は表示済み広告・impressionとして扱わない。

\* 次の新しい広告機会では新しい広告を通常どおりロードできる。

\*
掲示板Native広告はスクロールして画面外へ出ただけではdisposeせず、広告枠削除時または画面破棄時にdisposeする。

**\### 18.5 NativeAdFactoryとAd Unit**

ニュース一覧とAI掲示板ではNative広告レイアウトを分離する。

\`\`\`text

newsNativeFactory

threadNativeFactory

\`\`\`

Ad Unitは次の3種類とする。

\`\`\`text

news_banner

news_native

thread_native

\`\`\`

\* \`news_banner\`: ニュース一覧下部Anchored Adaptive Banner。

\* \`news_native\`: ニュース一覧Native広告。画像・動画を許可する。

\* \`thread_native\`:
AI掲示板Native広告。画像を許可し、動画は使用しない。

\* ニュースNativeのカテゴリ先頭 / 10件間隔でAd Unitを分けない。

\* 掲示板Nativeの \`normalComment\` / \`postContribution\` でAd
Unitを分けない。

\* 配置差は独自計測データの属性として記録する。

**\### 18.6 Debug / Release**

\* Debug buildではGoogle公式テストAd Unit IDだけを使用し、本番Ad
Unitへリクエストしない。

\* エミュレーターおよび物理Android端末へインストールしたDebug
buildもテスト広告を使用する。

\* Release buildでは本番AdMob IDを使用する。

\* build
modeで自動切替し、ユーザー向けの手動テスト広告ON/OFF設定は設けない。

\* AdMob関連IDは \`AdMobConfig\`
等へ集約し、各Widgetへ文字列を散在させない。

\* Release用IDはDartソースへ本番値を直接記述せず、\`--dart-define\`
から取得する。

Releaseで必要な定義:

\`\`\`text

ADMOB_APP_ID

ADMOB_NEWS_BANNER_ID

ADMOB_NEWS_NATIVE_ID

ADMOB_THREAD_NATIVE_ID

\`\`\`

\`ADMOB_APP_ID\` はGradle経由でAndroidManifestへ反映する。

広告ユニットIDは \`String.fromEnvironment\`
等の一元化された構成から取得する。

Releaseで必要なAdMob
IDが不足している場合は、誤った状態で成果物を作らずビルドを失敗させる。

**\### 18.7 UMP / プライバシー**

Google User Messaging Platform（UMP）を使用する。

アプリ側の基本処理:

1\. アプリ起動ごとに \`requestConsentInfoUpdate()\` を実行する。

2\. 必要な場合は \`loadAndShowConsentFormIfRequired()\` を使用する。

3\. 広告リクエスト開始前に \`canRequestAds()\` を確認する。

4\. \`canRequestAds()\` がtrueになった後に広告を要求する。

\* 地域判定をアプリ独自ロジックで固定せず、UMPの判定へ委ねる。

\* UMPの同意状態を独自SharedPreferences値だけで代替しない。

\* \`canRequestAds()\`
が複数のコールバック経路からtrueになっても、広告初期化・初回ロードを二重実行しない。

\* \`getPrivacyOptionsRequirementStatus()\`
がrequiredの場合、ユーザーが開けるプライバシー設定入口を表示し、\`showPrivacyOptionsForm()\`
を実行できるようにする。

\*
ニュース一覧AppBarに設定入口を設ける。設定画面には少なくとも「外観」「保存したニュース」「RSS登録・管理」「非表示にしたサイト」「プライバシー設定」への入口を置く。

UMPの欧州規制向けメッセージ対象地域は次とする。

\* EEA

\* 英国

\* スイス

対象地域で必要な場合、同意UIでは次の選択肢を提供する。

\* 同意

\* 同意しない

\* オプションを管理

ユーザーが後からPrivacy
Optionsから同意内容を確認・変更できる状態を維持する。

**\### 18.8 広告計測**

広告SDKのimpressionと実収益イベントを分離して記録する。

各物理広告枠 / 広告インスタンスには \`adInstanceId\` を付与する。

基本イベント:

\`\`\`text

ad_slot_created

ad_load_requested

ad_loaded

ad_load_failed

ad_impression

ad_paid

\`\`\`

\* \`ad_impression\` を収益確定として扱わない。

\* \`ad_paid\` ではSDKから取得できる価値、通貨、precision等を保存する。

\* 物理広告の収益は \`adInstanceId\`
単位で1回だけ計上し、複数の関連関係を持つ場合でもグローバル収益を二重計上しない。

広告イベントには必要に応じて次の属性を持たせる。

\`\`\`text

adFormat: banner / native

screen: news / thread

placement:

fixedBanner

newsTop

newsInterval

normalComment

postContribution

category

position

\`\`\`

\* \`category\` はニュースNativeで使用する。

\* \`position\`
は10件間隔広告の10、20、30...等の論理位置を記録できるようにする。

\* top / interval、カテゴリ、normalComment / postContributionはAd
Unitを分けなくても生データ上で区別できるようにする。

AI生成との採算分析では次の識別子を扱う。

\`\`\`text

generationId

contributionId

adOpportunityId

threadAdSequence

adInstanceId

\`\`\`

\* 実際のAI APIリクエストごとに \`generationId\`
を付与し、モデル、\`sharedAi\` / \`localAi\`、input token、output
token、APIコスト、成功 / 失敗を記録できるようにする。

\*
APIコストを取得・算出できない場合は推測値を実コストとして保存せず、null等で区別する。

\* DB HIT等でAI
APIを実行していない場合はAI生成コスト・AI生成→広告impression率の母数へ含めないが、その広告収益自体はグローバル広告指標へ含める。

\* 掲示板の論理的な広告機会には \`adOpportunityId\` を付与する。

\* \`normalComment\` が未閲覧のまま \`postContribution\`
へ置換された場合、置換前後の物理広告は別 \`adInstanceId\`
とするが、同じ論理広告機会であれば同じ \`adOpportunityId\` を共有する。

\* \`threadAdSequence\`
は掲示板内の論理的な第何広告機会かを表し、同一機会の置換では別の番号へ増やさない。

\* \`postContribution\` は対応するユーザー投稿の \`contributionId\`
と、実際にlocalAi API生成が発生した場合はその \`generationId\`
を関連付ける。

\* 置換元 \`normalComment\` がsharedAi生成に対応する場合は、shared側
\`generationId\` との関係も保持できるようにする。

\* 同一の \`postContribution\`
がshared側広告機会とlocalAi生成の両方に関連していても、\`ad_paid\`
の収益は物理 \`adInstanceId\` で一度だけ計上する。

\*
現行の計測機能は計測・保存・集計を責務とし、広告表示可否やAI生成可否を採算率によって自動変更しない。

**\## 19. 保存ニュース**

\* ユーザーはニュースを端末へ保存できる。

\* 保存ニュース一覧への入口は設定画面に置く。

\* ニュース一覧画面下部には保存ニュース用のナビゲーションを設けない。

\* 保存ニュース一覧から対象記事を開ける。

\*
RSS削除や共有ニュースキャッシュの更新によって、保存済み記事を自動削除しない。

\* 6.8
のサイト非表示設定は保存ニュースには適用しない。配信元サイトを運営ニュースで非表示にしていても、ユーザーが明示的に保存した記事は保存ニュースから消さない。

**\### 19.1 ローカル保存内容**

保存記事は、共有ニュースキャッシュから消えた後も保存一覧と既読内容を維持できるよう、端末へ記事情報と読み込み済みスレッド内容を保存する。

少なくとも次を保存する。

\* 記事タイトル

\* description

\* 元記事URL

\* 配信元名

\* 端末で既に読み込んだ \`sharedAi\` チャンク

\* ユーザー本人の \`user\` 投稿

\* そのユーザー投稿を起点に生成された \`localAi\`

\* ユーザー投稿の削除済み状態

記事画像等、既存の保存一覧表示に必要な付加情報は必要に応じて保存できる。

保存操作時にサーバー上の全共有AIチャンクを先読みしない。保存時点で端末に読み込み済みの
\`sharedAi\`
だけを保存し、その後さらに共有チャンクを読み込んだ場合はローカル保存へ追加する。

保存記事のローカルデータは共有AIキャッシュとは分離し、\`user\` /
\`localAi\` をSupabaseの共有 \`thread_chunks\` へ保存しない。

**\### 19.2 保存記事の表示と継続利用**

保存記事を開いた場合は、端末へ保存済みのスレッド内容を復元して表示できる。

\* 再表示時のスクロール位置は復元せず、レス表示は先頭から開始する。

\*
同じ詳細画面が開いている間のスクロール位置と表示状態は10章に従って維持する。

\*
サーバー側の記事・スレッドが存在する間は通常のライブスレッドとして扱い、必要に応じて次の
\`sharedAi\` チャンクを取得または生成できる。

\* 新しく読み込んだ \`sharedAi\` は保存記事のローカルデータへ追加する。

\* 新しい \`user\` 投稿と、それに対して生成された \`localAi\`
もローカルデータへ反映する。

保存記事を開いただけでは、サーバー上の記事・スレッドがまだ存在するか確認するための追加通信を行わない。

次の共有AIチャンクが必要になった場合やユーザー投稿を行う場合など、サーバー処理が実際に必要になった時点で状態を確認する。

**\### 19.3 サーバー側スレッド終了後**

サーバー処理が必要になった時点で、対象記事・スレッドがサーバー側に明確に存在しないことを確認した場合、その保存記事を読み取り専用ローカルアーカイブとして扱う。

読み取り専用状態では次のようにする。

\* 端末へ保存済みの
\`sharedAi\`、\`user\`、\`localAi\`、削除済み表示は引き続き閲覧できる。

\* 新しい \`sharedAi\` の取得・生成を行わない。

\* 新しいユーザー投稿を受け付けない。

\* 新しい \`localAi\` を生成しない。

\* 投稿UIを表示せず、`このスレッドは終了しました` と表示する。

\*
元記事URLは保持し、配信元サイト側でURLが有効であれば10章の元記事リンクから開ける。

timeout、通信不能、5xx等の一時的な通信・サーバーエラーは「サーバー側に存在しない」とみなさない。一時エラーだけを理由に読み取り専用状態へ確定しない。

**\## 20. 配布・プライバシー・セキュリティ**

**\### 20.1 Android Release署名**

Android ReleaseはGoogle Play公開用のupload keyで署名する。

署名設定は \`android/key.properties\` を経由して読み込む。

次をソースコードへ直接記述しない。

\* store password

\* key password

\* keystore本体

\`key.properties\`、\`.jks\`、\`.keystore\` はGit管理対象外とする。

Release署名設定とDebug署名設定を混同しない。

**\### 20.2 プライバシーポリシー**

「AI速」のプライバシーポリシーを一般公開する。

公開先:

\`\`\`text

https://aisoku-support.github.io/aisoku/privacy.html

\`\`\`

問い合わせ先:

\`\`\`text

aisoku.support@gmail.com

\`\`\`

プライバシーポリシーでは少なくとも次の利用・処理を説明する。

\* Google AdMob / Google Mobile Ads SDK

\* Google UMP

\* Supabase

\* Upstash Redis

\* AI生成サービスおよび関連API

\* NewsData.ioおよびRSS配信元

\* 広告関連計測

\* AI生成関連の技術情報

\* ユーザー投稿

\* AI生成コンテンツ

\* AI生成レス通報

\* 情報の保持・削除

\* 問い合わせ先

**\### 20.3 セキュリティ上の原則**

\* APIキー、Access
Token、Secretをソースコード、仕様書、ログ、チャットへ出力しない。

\* Flutterへ書き込み権限付きUpstashトークンを配置しない。

\*
ユーザー投稿全文、AI返却全文、ニュース本文全文を診断ログへ出力しない。

\*
AIレス本文や通報の「その他」の自由記述の全文、認証情報、その他機密情報もログへ出力しない。

\* 広告データをAIレスデータへ混在させない。

\* ユーザー固有会話を共有AIキャッシュへ保存しない。

\*
AIへ渡す外部データやユーザー入力を生成ルールを変更する命令として扱わせない。

\* Release署名用パスワードやkeystoreをGitへ含めない。

\*
AdMob本番IDはコード各所へ散在させず、一元管理されたRelease設定から取得する。

**\## 21. 外観（テーマ）設定**

\* アプリ全体で「端末の設定に従う」「ライト」「ダーク」の3種類のテーマを選択・切り替えできる。

\* 初期値は「端末の設定に従う」（`ThemeMode.system`）。

\* 設定画面の「外観」メニューからダイアログでテーマを変更でき、選択状態はSharedPreferences（キー名: `theme_mode`）へ保存され端末に永続化される。

\* ライト・ダーク共にブランドの青色を維持し、ダークテーマは黒に近いダークグレー（`#121212`、`#1E1E1E`）を基本とする。

\* ニュース一覧、カテゴリタブ、スレッド、コメント、入力欄、保存ニュース、設定、BottomSheet、Dialog、Snackbarなどの配色が選択テーマに応じて動的に変化する。

\* 広告枠・周辺背景はテーマ色に追従し、広告素材自体は改変しない。

\* テーマ変更時に画面遷移、ニュース再取得、スクロール位置や入力内容の初期化を発生させない。

**\## 22. 仕様参照**

各機能の現行仕様は本書の該当章を正とする。

コード、Service、Controller、Edge Function、状態、テスト等の調査入口は
\`docs/FEATURE_MAP.md\` を参照する。
