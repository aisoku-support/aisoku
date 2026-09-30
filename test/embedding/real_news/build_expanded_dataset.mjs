import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve('test/embedding/real_news');
const articleDoc = JSON.parse(fs.readFileSync(path.join(dir, 'articles.json'), 'utf8'));
const candidateDoc = JSON.parse(fs.readFileSync(path.join(dir, 'pair_candidates.json'), 'utf8'));
const articles = articleDoc.articles;
const byId = new Map(articles.map((a) => [a.article_id, a]));

function pair(a, b, label, reason) {
  if (!byId.has(a) || !byId.has(b)) throw new Error(`unknown_article_in_pair:${a}:${b}`);
  const left = byId.get(a), right = byId.get(b);
  const same = left.topic_id && right.topic_id && left.topic_id === right.topic_id;
  const different = left.topic_id && right.topic_id && left.topic_id !== right.topic_id;
  const historyConflict = Boolean((same && label !== 'merge') || (different && label === 'merge'));
  return {
    article_id_a: a,
    article_id_b: b,
    label,
    reason,
    existing_topic_relation: same ? 'same_topic' : different ? 'different_topics' : 'topic_history_unavailable',
    topic_id_a: left.topic_id,
    topic_id_b: right.topic_id,
    topic_match_method_a: left.topic_match_method,
    topic_match_method_b: right.topic_match_method,
    differs_from_existing_topic_relation: historyConflict,
  };
}

const oldLabels = [
  ['merge', 'ETF銘柄コード650Aの東証上場承認を扱う同一の承認発表。タイトルと説明が同じプレスリリースを示す。'],
  ['uncertain', '一方はiPhone Duoの体験・製品意図、他方は競合機種との比較で、同一製品を扱うが同じ報道上の出来事とは限らない。'],
  ['uncertain', '比較記事とiPhone Duoの一般的な紹介記事で、説明文だけでは同じ記事系列か独立した論評か確定できない。'],
  ['merge', 'タイトルが同一の折りたたみスマホ3機種比較記事で、説明も同じ比較内容を示す。'],
  ['merge', '東京ばな奈35周年と現在の人気を扱う同一記事。タイトル・説明がほぼ一致する。'],
  ['merge', '松竹による同作品Blu-rayの12月23日発売発表。記事タイトルと説明の告知内容が一致する。'],
  ['merge', '同じ日経クロステックのiPhone 18 Pro分解結果を扱い、冷却重視の内部構造という具体的な知見も一致する。'],
  ['separate', '同じチップ製品でも一方は発表、他方は量産・スマートフォン搭載の報道で、別の進展段階を扱う。'],
];
const oldPairs = candidateDoc.same_topic_pairs.map((p, i) => ({
  ...pair(p.article_id_a, p.article_id_b, oldLabels[i][0], oldLabels[i][1]),
  pair_source: 'existing_same_topic_candidate',
  historical_merge_similarity: p.merge_similarity,
}));

const oldNegativeLabels = [
  ['separate', '共通するのはCCPJAPANのMSSソフビというシリーズまでで、ヘドラとゴジラの別商品を異なる店舗向けに発売する。'],
  ['merge', '同じ9月25日の東京市場での日経平均上昇を扱う後場速報と13時50分時点の更新。差は同一取引日の進行に伴う数値更新とみなす。'],
  ['separate', '記事本文にあるイベントはNTT西日本のスポーツ観戦実証とベルセルクのフィギュア商品化で無関係。類似するevent文字列は汎用値「対象記事」に由来する。'],
  ['separate', 'マンションのデザインと東京ばな奈35周年は別の対象・出来事。「話題」という一般語以外に共通性がない。'],
  ['separate', 'マンションのデザインと東京ばな奈35周年は別の対象・出来事。「話題」という一般語以外に共通性がない。'],
  ['separate', '大相撲の取組結果とゲーム依存・セルフコントロールの記事で別の出来事。類似するevent文字列は汎用値「対象記事」に由来する。'],
];
const oldNegativePairs = candidateDoc.different_topic_similar_candidates.map((p, i) => ({
  ...pair(p.article_id_a, p.article_id_b, oldNegativeLabels[i][0], oldNegativeLabels[i][1]),
  pair_source: 'existing_different_topic_candidate',
}));

const additions = [
  pair('8158b4f376030bbcd8bfccceb8cbdee7', 'f0460a945a2c497f733901809772b457', 'merge', '9月25日の同一東京市場における日経平均の前場終値と後場寄り付きの速報。市場の進行を追う続報として同一イベントにまとめる。'),
  pair('5f1e766344e866536271356201420330', 'ab8d7c67a4ebe59d8dfc927a021728f7', 'merge', '同日の後場13時50分時点の上昇速報と大引けの結果。日中の同一取引イベントの経過報道。'),
  pair('037d334686f41ec87c43065af9d0c6a9', 'ab8d7c67a4ebe59d8dfc927a021728f7', 'uncertain', 'どちらも25日の日経平均5日続伸・半導体株高を報じるが、Reuters側説明は他記事見出しを含む配信集約文で、独立した本文の同一性までは確認できない。'),
  pair('fab190426d00fbe7d392fe65c1d34818', 'f2858b6aeae2684acaf14b808dc973ef', 'merge', '同じライフハッカーの折りたたみスマホ比較記事を示す。後者の説明は複数記事の集約を含む。'),
  pair('647bc98284ebf69c5903d49c9f45f10f', 'fe3b378e0f6a31b04b066f32470b3549', 'uncertain', 'タイトルは同じiPhone Duo保護フィルム記事だが、両説明にiPhone 18関連の複数見出しが混在し、記事本体の一致を本文記録だけから断定しにくい。'),
  pair('f2858b6aeae2684acaf14b808dc973ef', '685eac9fb15e7b1240a6e1e1de92dd26', 'separate', '同じiPhone Duoを扱うが、機種間比較記事と購入理由を解説する動画紹介で、別の編集内容・出来事。'),
  pair('f2858b6aeae2684acaf14b808dc973ef', 'bf363da429a858126168580780de4176', 'separate', '同じiPhone Duoの話題でも、製品比較とCEO・デザイナーの開発背景インタビューは別の報道内容。'),
  pair('99046ddbb53798b011b5c5e69b7404ef', '3f135d697288237bbb51f83a87be447d', 'separate', '同じiPhone 18 Proの分解記事だが、iFixitの可変絞り・修理性検証と日経クロステックの冷却設計調査という独立した分析。'),
  pair('99046ddbb53798b011b5c5e69b7404ef', '20176e777841ac88246b83b65e548079', 'separate', 'iPhone 18 Proという同一製品でも、一方は分解・修理性、他方はFace ID後の再起動不具合と修正予定を扱う。'),
  pair('3f135d697288237bbb51f83a87be447d', '782326a4562c7e35f65edb8fbba09906', 'separate', '両方ともiPhone 18 Proの分解に関連するが、冷却を含む筐体内部調査とTSMC製A20 Proの2nm構造解析で対象・結論が異なる。'),
  pair('99046ddbb53798b011b5c5e69b7404ef', '782326a4562c7e35f65edb8fbba09906', 'separate', 'iPhone 18 Proを題材にした独立した分解解析。iFixitはカメラ機構・修理性、TechInsightsはTSMCのトランジスタ構造を調べている。'),
  pair('99046ddbb53798b011b5c5e69b7404ef', 'd80ab386f6556226a3ae08de9bc6fa17', 'separate', '同じiPhone 18 Pro向けでも、端末分解の調査報道と第三者製ケースの発売は別イベント。'),
  pair('d80ab386f6556226a3ae08de9bc6fa17', '9c257ec44e3fff5a2eadee954c35d7d8', 'separate', '同じiPhone 18 Pro用ケースだが、ラスタバナナの耐衝撃ケース発売とMOFTの軽量レザーケースレビューで企業・製品・記事種別が異なる。'),
  pair('d80ab386f6556226a3ae08de9bc6fa17', '20176e777841ac88246b83b65e548079', 'separate', '同じiPhone 18 Proに関する記事でも、ケース新製品の発売とFace ID後の再起動不具合は別出来事。'),
  pair('f2858b6aeae2684acaf14b808dc973ef', '20176e777841ac88246b83b65e548079', 'separate', 'Apple製品という共通点はあるが、折りたたみiPhone Duoの比較とiPhone 18 Proのソフトウェア不具合は異なる機種・出来事。'),
  pair('e1dfe7ab33fb0a80e7b36e65f1669852', '1d91b16a8c315f26b3bb10551fb494c9', 'separate', 'どちらもアニメ作品のLINEスタンプ配信開始だが、『片田舎のおっさん剣聖になるII』と『MAO』という別作品の商品告知。'),
  pair('64f335f2efef6c78b5e3b25afdac7135', 'ece993fca8363a3e26d90f5983215615', 'separate', 'いずれも経済産業省に関する論評だが、コンテンツ海外展開予算と省庁人事・組織運営への批判という別の政策論点。'),
  pair('67d14a755c3bd469b4e6b7965ab0f5fe', 'b39ead71f49dc23aa248a5bcfbf0f40d', 'merge', 'キャンメイクの同じ新色チーク・クッションファンデ・限定ライナー発売記事。タイトルと説明の先頭が一致する媒体間重複。'),
  pair('782326a4562c7e35f65edb8fbba09906', 'f7dd7140938e7990b366b6327ebfb4d6', 'separate', 'どちらも半導体・スマートフォン関連だが、TSMCのN2製造構造解析とHuawei Kirin 9050 Proの発表・搭載で企業とイベントが別。'),
  pair('63acafd247e79b4ee037b90f67cfc138', 'e1dfe7ab33fb0a80e7b36e65f1669852', 'separate', 'ソフビの限定発売とアニメLINEスタンプ配信で、サブカル分野内でも対象・出来事が異なる。'),
];
for (const p of additions) p.pair_source = 'new_manual_candidate';

const allPairs = [...oldPairs, ...oldNegativePairs, ...additions];
const counts = Object.fromEntries(['merge', 'separate', 'uncertain'].map((label) => [label, allPairs.filter((p) => p.label === label).length]));
const inputs = articles.map((a) => ({
  article_id: a.article_id,
  input_method: 'title_description',
  title: a.title ?? null,
  description: a.description ?? null,
  article_input: [a.title, a.description].filter((v) => typeof v === 'string' && v.trim()).join('\n\n') || null,
  title_missing: !(typeof a.title === 'string' && a.title.trim()),
  description_missing: !(typeof a.description === 'string' && a.description.trim()),
  existing_topic_embedding_input: a.embedding_input ?? null,
}));

const review = {
  schema_version: '1.0',
  source_articles: 'articles.json (read-only snapshot)',
  source_candidates: 'pair_candidates.json (read-only candidate list)',
  labeling_basis: 'Manual comparison of stored title and description; topic relation retained as history metadata only.',
  labels: { merge: 'same event; merge together', separate: 'different events; keep separate', uncertain: 'insufficient evidence to decide' },
  counts,
  total_pairs: allPairs.length,
  existing_pair_reviews: [...oldPairs, ...oldNegativePairs],
  additional_pairs: additions,
};

fs.writeFileSync(path.join(dir, 'article_specific_inputs.json'), JSON.stringify({
  schema_version: '1.0',
  article_count: inputs.length,
  input_rule: 'title + newline + newline + description; no subject/event or generated fields are added.',
  articles: inputs,
}, null, 2) + '\n');
fs.writeFileSync(path.join(dir, 'pair_review_expanded.json'), JSON.stringify(review, null, 2) + '\n');

const conflicts = allPairs.filter((p) => p.differs_from_existing_topic_relation);
const uncertain = allPairs.filter((p) => p.label === 'uncertain');
const report = `# 実ニュースEmbedding比較データセット拡充

## 対象と方法

- 入力: 保存済み実ニュース200記事（\`articles.json\`）と既存候補14ペア（\`pair_candidates.json\`）。元データは変更していない。
- 既存14ペアをtitle・descriptionで再確認し、さらに200記事内から難しい比較ペア20件を追加。合計${allPairs.length}ペア。
- ラベルは記事内容の同一イベント性に基づく暫定人手判定。既存Topic IDやmerge履歴を正解とは扱わず、別途比較項目として保存。
- 記事固有入力は全${inputs.length}記事についてtitleとdescriptionを\`title + 空行 + description\`で連結。description欠損は推測せず空欄のまま。既存Topic単位の\`embedding_input\`は別フィールドに保持。
- 記事固有subject/eventの抽出、API呼び出し、DB等への書き込みは行っていない。

## ラベル件数

| ラベル | 件数 |
|---|---:|
| merge | ${counts.merge} |
| separate | ${counts.separate} |
| uncertain | ${counts.uncertain} |
| 合計 | ${allPairs.length} |

## 判断が難しいペア

${uncertain.map((p) => `- \`${p.article_id_a}\` / \`${p.article_id_b}\`: ${p.reason}`).join('\n')}

## 既存Topic履歴と異なる判定

Topic IDが両方あるペアのうち、同一Topicなのにseparate/uncertain、または異なるTopicなのにmergeとしたものは${conflicts.length}件。内訳は次の通り。

${conflicts.length ? conflicts.map((p) => `- \`${p.article_id_a}\` / \`${p.article_id_b}\`: 履歴=${p.existing_topic_relation}、判定=${p.label}。${p.reason}`).join('\n') : '- 該当なし'}

Topic未作成・未リンク記事を含むペアは履歴との一致を比較できず、\`topic_history_unavailable\`と記録した。

## subjectによる候補除外が有効そうな事例

- NTT西日本のスポーツ観戦実証とベルセルクのフィギュア記事、ならびに大相撲の取組記事とゲーム習慣の記事は、汎用event「対象記事」の文字列類似が候補に混入した。記事固有subjectが異なるため、候補除外の手掛かりとして有効そう。
- マンションの話題と東京ばな奈の記事は汎用的な「話題」が重なる一方、対象subjectが異なる。
- ヘドラとゴジラのソフビは企業とシリーズが同じでも製品・発売先が異なる。subjectを企業・シリーズだけに丸めず製品単位で扱う必要がある。

subject一致を必須にすると、別名表記・広い親subject・記事の観点差で真の同一イベント候補を落とす可能性がある。除外条件ではなく段階的な候補優先付けとしての評価が必要。

## 評価データとしての限界

- 保存済み説明文の欠損・短縮・複数見出し混在があり、記事本文全体を確認できない。特に\`uncertain\`は正解ラベルにせず個別確認が必要。
- ペアは全200記事から網羅的に作ったものではなく、同一Topicの複数記事や候補生成で拾われた記事に偏る。カテゴリ分布も均衡していない。
- merge/separate判定には編集上のTopic粒度が影響する。同じ企業・製品でも別発表はseparateとしたが、速報・続報をどこまで同一イベントとするかは用途依存。
- 閾値調整用と最終評価用の分割、記事・出来事単位での重複リーク防止はEmbedding実験時に別途設計する必要がある。
- 今回は文章照合による暫定ラベルであり、独立した複数評価者による一致度評価は行っていない。

## ファイル

- \`pair_review_expanded.json\`: 既存14ペアの再判定と追加20ペア、理由、Topic履歴メタデータ。
- \`article_specific_inputs.json\`: 200記事の記事固有入力と欠損状態。既存Topic単位入力も別フィールドで保持。
`;
fs.writeFileSync(path.join(dir, 'expansion_report.md'), report);

console.log(JSON.stringify({ articles: inputs.length, pairs: allPairs.length, counts, topic_history_conflicts: conflicts.length, output: ['article_specific_inputs.json', 'pair_review_expanded.json', 'expansion_report.md'] }));
