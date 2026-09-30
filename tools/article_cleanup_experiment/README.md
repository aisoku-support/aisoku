# Readability後 Generic Block Cleaner 実験

保存済み `tools/readability_defuddle_comparison/runs/2026-09-22T07-26-43-315Z/` の Readability 成功記事だけを入力にしたローカル実験です。保存HTMLを再取得せず、外部HTTP・AI API・本番コード・DBへアクセスしません。

## 実行

`node src/run.mjs`

既存比較ランの `@mozilla/readability` 生成済み `content_html` を A/B 共通入力にし、A は textContent、B は同じDOMを `src/cleaner.mjs` で局所的に remove してから textContent 化します。Readabilityの実装条件は既存ランと同一で、バージョンは 0.6.0、JSDOM は 30.1.1 です。

## 判定方針

迷う場合は保持します。文言単独、高リンク密度単独、短文単独では削除しません。削除ログは `results/details/*.json` の `removed` に preview、文字数、リンク数、密度、score、理由を保存します。

## 結果

`results/summary.json` と `results/comparison.md` を参照してください。実HTMLの評価では Readability成功6件、人工fixture10件です。初回実験の結果は fixture 10/10 PASS、正常本文誤削除0件、実HTMLは improved 1 / unchanged 5 / regression 0 でした。

## A/B/C 実験

`node src/run-three.mjs` は保存済みHTMLから同一Readability条件で A（Baseline）、B（Post-clean）、C（Pre-clean + Readability + Post-clean）を実行し、`results/<timestamp>/` に比較結果を作成します。Pre-cleanは関連記事見出し・複数リンク・リンク密度・自然文不足・小さな独立containerの複合条件に限定し、CTA文言単独では削除しません。

今回のA/B/C runでは実HTML6件、fixture20件、Readability選択変化0件、正常本文誤削除0件、fixture 20/20 PASSでした。日経関連記事は保存HTML上のPre-cleanでは安全条件を満たさず保持され、はちまの商品カードはPost-cleanで従来どおり削除されました。

この結果から本番導入候補は、独立ブロック内で `rel="sponsored"` があり、商品カード構造も伴うルールに限定します。関連記事やCTAの複合ルールは人工fixtureでは成立しましたが、実HTMLでの確認数が少ないため medium とし、本番導入は追加データでの検証後とします。
