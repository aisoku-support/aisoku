# 23記事比較 実行記録

実行日: 2026-09-20

## 実行範囲

- 対象記事: 23件（ID重複0、URL重複0、title/description欠損0）
- 実行条件: `sharedAi`、10コメント、temperature 0.95、max output tokens 1200
- GPT-OSS: `reasoning_effort: low`
- Qwen: `reasoning_effort: none`
- Gemma: `messages`、`enable_thinking: false`
- runner実行回数: 69回（各モデル23回、retryなし）

## 結果

| Model | 実行 | HTTP 2xx | JSON 10件成功 | finish | latency | completion | reasoning | Neurons |
|---|---:|---:|---:|---|---:|---:|---:|---:|
| GPT-OSS 120B | 23 | 23 | 22 | stop: 23 | 平均768.3ms / median787ms | 平均198.5 / 合計4566 | 平均28.7 / 合計660 | — |
| Qwen 3.8 27B | 23 | 0 | 0 | 未取得: 23 | 未取得 | 未取得 | 未取得 | — |
| Cloudflare Gemma 4 | 23 | 0 | 0 | 未取得: 23 | 未取得 | 未取得 | 未取得 | 未取得 |

QwenとCloudflareは全件`fetch failed`となり、HTTP responseがありませんでした。したがって、JSON形式、内容品質、latency、token、Neuronsは評価不能です。取得できなかったモデルについて捏造・推測・自然さの評価は行っていません。

GPT-OSSについては、JSON 22/23、10コメント完成22/23、API error 0、形式失敗1件でした。内容評価はtitle/descriptionだけを根拠に別途行う必要がありますが、今回の通信障害により3モデル横断比較は未完了です。

## 結果ファイル

各requestのJSONは同ディレクトリの`smoke-2026-09-20T05-37-*.json`（GPT-OSS）、`05-44-*.json`（Qwen）、`05-45-*.json`〜`05-47-*.json`（Cloudflare）に保存されています。`request_count: 0`の誤ったProvider指定ファイルは集計対象外です。

APIキー、Authorization、Cloudflare Account ID/Tokenは保存・表示していません。

## 追加診断

その後、同一記事でQwenとGemmaを各1回だけ再確認した。両方ともHTTP response前に`TypeError: fetch failed`となり、診断情報は`cause.name: AggregateError`、`cause.code: EACCES`だった。したがって、今回の失敗はProviderからの429/400等ではなく、Node実行環境の外向き通信権限またはソケット接続権限の問題が最有力である。追加確認は行っていない。

## 指定結果による最終分析

採用範囲はGPT-OSSの05:37〜05:39の23件、Qwenの06:10〜06:11の23件、Gemmaの06:12〜06:13の23件に限定した。3モデルとも同一23 article ID、各モデル内重複なしで、69件の対応は完全一致した。

### 機械的結果

| 指標 | GPT-OSS 120B | Qwen 3.8 27B | Gemma 4 |
|---|---:|---:|---:|
| request | 23 | 23 | 23 |
| HTTP 2xx | 23/23 | 7/23 | 23/23 |
| API error | 0 | 16 | 0 |
| JSON成功（配列10文字列） | 22/23 (95.7%) | 5/23 (21.7%) | 23/23 (100%) |
| 10コメント完成 | 22/23 (95.7%) | 5/23 (21.7%) | 23/23 (100%) |
| finish_reason | stop:23 | stop:7、N/A:16 | stop:23 |
| latency | 平均768.3 / median787 / 611–941ms | 平均308.8 / median200 / 187–603ms（HTTP応答7件を含む全結果の保存値） | 平均3437.6 / median2553 / 1489–24534ms |
| input tokens | 平均540.5 / 合計12432 | 平均385.3 / 合計2697（7件） | 平均421.2 / 合計9688 |
| completion tokens | 平均198.5 / 合計4566 | 平均159.4 / 合計1116（7件） | 平均118.3 / 合計2720 |
| total tokens | 平均739.0 / 合計16998 | 平均544.7 / 合計3813（7件） | 平均539.5 / 合計12408 |
| reasoning tokens | 平均28.7 / 合計660 | N/A | N/A |
| Neurons | N/A | N/A | 平均7.0545 / 合計162.2545 |

QwenのAPI error 16件は、モデルの内容生成失敗ではなく、GroqのOTPМ制限応答だった。内訳は`Request too large ... Requested 1200`が5件、`Rate limit reached ... output tokens per minute (OTPM)`が11件。HTTP応答を得た7件のうち、5件は正しいJSON配列、2件は`responses`/`res` objectだった。

### 内容評価

内容評価は、各記事のtitle/descriptionのみを根拠にした。E（明確な矛盾）は明確に確認できたものだけ、Dは具体的な数字・固有事実が入力にない断定だけを数える保守的判定とした。A〜Eは重複せず、E > D > C > A/Bの順で優先した。機械的な語句スクリーニングを補助に使ったため、品質の最終判定ではなく比較用の観察値である。

| 分類 | GPT-OSS | Qwen | Gemma |
|---|---:|---:|---:|
| 評価可能コメント | 220 | 70 | 230 |
| A 根拠あり | 180 | 55 | 197 |
| B 一般的感想 | 39 | 13 | 33 |
| C 推測・疑問 | 0 | 1 | 0 |
| D 根拠なし具体的断定候補 | 1 | 1 | 0 |
| E 明確な矛盾 | 0 | 0 | 0 |
| D+E率 | 0.5% | 1.4% | 0.0% |

QwenはAPI error 16件を内容評価の母数に含めず、JSON objectだった2件はJSON成功とは扱わず、内容が明確に読めるため評価可能コメントとして扱った。

### 代表的な観察

- GPT-OSS: 景況感記事で「企業の利益が伸びそう」「給料も上がるかな」など、短い掲示板反応と疑問が混在した。失敗1件は記事内容ではなく、配列要素間のカンマ欠落によるJSON構文エラーで、rawには途中まで複数コメントが残っていた。
- Qwen: 大麻逮捕記事では「車内温度」「商業施設の駐車場」「石巻は海沿い」など、descriptionにない具体化が見られ、記事根拠から外れる候補があった。`responses`/`res` objectの2件は内容自体は10要素相当だったが形式不遵守である。
- Gemma: 株価記事の「純利益減なのに株価上がってて草」、災害記事の「二次災害が一番怖い」など、短い反応・疑問・不安が混ざり、23件すべてJSON 10件を完了した。今回のmessages方式では制御情報漏出や反復形式崩壊は確認されなかった。

掲示板らしさは、GPT-OSSとGemmaで短文反応・疑問・驚きが混在しやすく、Gemmaは形式を保ったまま安定した。Qwenは取得できた5配列では自然な短文もある一方、出力形式が不安定で、全23記事を通した内容傾向の比較母数が不足した。会話感はいずれも明確な相互返信ではなく、独立した反応の集合が中心だった。Gemmaは多様性とJSON安定性の両立が観察されたが、総合順位は付けない。

### カテゴリ

`articles.json`のカテゴリフィールドは`app_categories`配列で、23記事すべて複数カテゴリではなく配列形式。ただし1記事が複数カテゴリに属するため、カテゴリ別件数は単純合計が23を超える。実集計はトレンド6、エンタメ5、サブカル5、マネー7、IT・ガジェット5（延べ28）である。

### 追加検証課題

Qwenは現在の`max_tokens:1200`がOTPМ 1000制限と衝突するため、同一条件のまま全件比較を継続するにはquota条件または出力上限の扱いを別途決める必要がある。JSON自動修復やretryは導入しない。Gemmaはmessages＋thinking無効化で機械的には安定したが、Neuronsと長時間latencyの継続監視が必要である。内容品質は今回の保守的分類だけでなく、人手評価者間一致を含む別検証が望ましい。

## Qwen max_tokens 400 追加検証

対象は前回`request too large`だった2記事と、OTPM rate limitだった1記事の計3記事。既定値1200は維持し、CLIでのみ`--max-output-tokens 400`を指定した。

Codex実行環境からの3 requestはいずれもHTTP response前に`fetch failed`（既知の`AggregateError/EACCES`）となった。したがって、400による`request too large`改善、OTPM改善、completion tokens、JSON安定性は判定不能である。通常PowerShellでの再実行結果ではないため、QwenのAPI性能結果として集計していない。
