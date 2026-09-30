# AI速 モデル比較用記事データセット

`articles.json` は、リポジトリ内に保存されていた `newsdata_articles.json` から選定した固定fixtureです。

現行の `generate-ai-replies` で通常の共有AI生成に記事側から渡る値は、`newsTitle`（`title`）と `articleBody`（`description`）です。Topicコンテキスト経路では `topicThreadTitle`、`topicSubject`、`topicEvent`、`topicFacts[]` が渡りますが、元ローカル記事レコードに存在しない値は追加していません。

比較時は各記事の `title` と `description` を同じプロンプト入力に使用してください。`app_categories`、`source`、`published_at`、URL類は元記事のメタデータです。

取得元はローカルファイルのみです。本データセット作成時にSupabase本番・AI APIへの通信は行っていません。

## 比較ランナー

`runner.mjs` は現行 `generate-ai-replies` の通常 `sharedAi` プロンプト形状をローカルで再現し、Providerだけを切り替えます。1記事の疎通テストは次のコマンドで実行します。

```powershell
node tools/model_comparison/runner.mjs --article-id <article_id>
```

実行前に `.env` または環境変数へ `GROQ_API_KEY`、`CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_API_TOKEN` を設定してください。1回の実行で3モデルへ各1 requestを送信し、結果を `tools/model_comparison/results/` に保存します。自動retryはありません。

実APIへ接続しないローカル確認:

```powershell
node tools/model_comparison/runner.mjs --mock
```

結果には、非成功レスポンスの安全なprovider error情報と、Groqのrate-limit診断用allowlist header（`retry-after`、`x-ratelimit-*`）だけを保存します。認証情報・Authorization header・Account IDは保存しません。
