# Local AI Model Benchmark

`tools/model_benchmark` は記事本文・facts・コメントを比較するローカルツールです。

## 起動

```powershell
node tools/model_benchmark/src/server.mjs
```

ブラウザで `http://127.0.0.1:4173` を開きます。

## 使い方

- 記事を選び、本文が未保存なら「本文を取得」→品質確認後「抽出本文を保存」を実行します。本文は300文字以上で、抽出・HTTP・多様性・広告／関連記事の品質確認を通過した場合に保存できます。
- 「本文 → facts」は保存済み本文を入力し、factsを `results/facts/<article_id>/` に永続保存します。
- 保存済みfactsを選び、「共通facts → コメント」または「モデル別facts → コメント」を実行します。生成したコメント結果には入力facts、参照元、プロンプト、モデル設定、生成状態を記録します。
- 実行前の確認画面に外部API呼び出し予定回数を表示します。mock実行やローカルテストでは外部APIを呼びません。
- 最新記事収集はBenchmark用記事の合計30件を目標にします。カテゴリ別の採用数は固定しません。NewsData.io検索は最大5回、候補の配信元ページ取得は最大50回です。品質不合格や重複候補を除外し、目標未達でも上限を超える検索は自動実行しません。

## 保存場所

- 記事: `dataset/articles/` と `dataset/articles.csv`
- facts: `results/facts/<article_id>/`
- Benchmark履歴: `results/results.csv` と `results/details/`
- モデル・Provider設定: `models/models.json`
- Prompt: `prompts/<model_id>/`

過去の23記事と過去結果は保持されます。

## ローカルテスト

```powershell
node --test tools/model_benchmark/tests/*.test.mjs
```

テストはmock実行のみで、外部APIを呼び出しません。

## 収集結果の診断記録

全体30件を目標にし、カテゴリ別目標は設けません。本文300文字以上、抽出成功、本文多様性を満たし、重複や広告・関連記事が多くない記事を採用して合格時点で保存します。候補の不採用理由は実行ごとに `results/collection-runs/<run_id>.json` へ簡潔に記録します。NewsData.io検索は最大5回、記事ページ要求はリダイレクト込み最大50回です。過去の `dataset/latest-collection-usage.json` は履歴として保持し、新しい実行の上限・進捗には再利用しません。
