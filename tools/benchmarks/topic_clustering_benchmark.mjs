import fs from 'fs';
import path from 'path';

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  console.error('Error: GEMINI_API_KEY environment variable is not set.');
  process.exit(1);
}

const GEMMA_MODEL = 'gemma-4-26b-a4b-it';
const EMBEDDING_MODELS = ['gemini-embedding-001', 'gemini-embedding-2'];

const EVAL_SET_PATH = path.join('tools', 'benchmarks', 'topic_clustering_eval_set_v2.json');
const FACTS_PATH = path.join('tools', 'benchmarks', 'topic_clustering_facts.json');
const RESULTS_PATH = path.join('tools', 'benchmarks', 'topic_clustering_embedding_benchmark_results.json');

const PROMPT_TEMPLATE = `あなたはニュース記事からファクトデータを抽出する専門家です。
与えられたニュースの「title」と「description」から情報を抽出し、指定されたJSON形式で出力してください。

【抽出ルール】
1. titleとdescriptionに明記されている情報だけを使用してください。
2. 推測禁止。一般知識による補完禁止。元記事にない事実を追加しない。
3. 数字、日付、金額、固有名詞を正確に保持する。
4. 不明な情報を無理に埋めない。
5. 主題(subject)は「対象(entity) + 主要イベント(event)」。
6. 同じ対象でも主要イベントが異なれば別topicになり得ます。
7. 単なる細部の違いは別topicにしない。価格、発売日、予約開始など、主要イベントに付随する情報は原則subtopic/factsに含める。
8. 1記事内に独立した主要イベントが複数存在する場合だけtopicsを複数生成する。無意味にtopicを細分化しない。
9. JSON以外を返さないでください。

【出力フォーマット】
{
  "topics": [
    {
      "subject": {
        "entity": "主な対象",
        "event": "主要イベント"
      },
      "subtopics": [
        "副題1",
        "副題2"
      ],
      "facts": [
        {
          "type": "事実の種類",
          "value": "元記事に明記された値"
        }
      ]
    }
  ]
}

【入力データ】
title: {{TITLE}}
description: {{DESCRIPTION}}`;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    topics: {
      type: "array",
      items: {
        type: "object",
        properties: {
          subject: {
            type: "object",
            properties: {
              entity: { type: "string" },
              event: { type: "string" }
            },
            required: ["entity", "event"]
          },
          subtopics: {
            type: "array",
            items: { type: "string" }
          },
          facts: {
            type: "array",
            items: {
              type: "object",
              properties: {
                type: { type: "string" },
                value: { type: "string" }
              },
              required: ["type", "value"]
            }
          }
        },
        required: ["subject", "subtopics", "facts"]
      }
    }
  },
  required: ["topics"]
};

let stats = {
  gemma_requests: 0,
  emb1_requests: 0,
  emb2_requests: 0,
  errors: 0,
  rate_limits: 0,
  gemma_elapsed_total: 0,
  emb_elapsed_total: 0
};

async function callGemini(model, body) {
  stats.gemma_requests++;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${API_KEY}`;
  const start = Date.now();
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const elapsed = Date.now() - start;
    stats.gemma_elapsed_total += elapsed;
    const data = await response.json();
    if (!response.ok) {
      stats.errors++;
      if (response.status === 429) stats.rate_limits++;
    }
    return { success: response.ok, elapsed, data };
  } catch (error) {
    stats.errors++;
    return { success: false, elapsed: Date.now() - start, error: error.message };
  }
}

async function callEmbedding(model, text) {
  if (model.includes('embedding-001')) stats.emb1_requests++;
  else stats.emb2_requests++;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${API_KEY}`;
  const start = Date.now();
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: { parts: [{ text }] }
      })
    });
    const elapsed = Date.now() - start;
    stats.emb_elapsed_total += elapsed;
    const data = await response.json();
    if (!response.ok) {
      stats.errors++;
      if (response.status === 429) stats.rate_limits++;
    }
    return { success: response.ok, elapsed, data };
  } catch (error) {
    stats.errors++;
    return { success: false, elapsed: Date.now() - start, error: error.message };
  }
}

function cosineSimilarity(vecA, vecB) {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function run() {
  const evalSet = JSON.parse(fs.readFileSync(EVAL_SET_PATH, 'utf8'));
  const articles = evalSet.articles;

  // 1. Gemma Fact Extraction
  let factsResults = {};
  if (fs.existsSync(FACTS_PATH)) {
    factsResults = JSON.parse(fs.readFileSync(FACTS_PATH, 'utf8'));
  }

  console.log(`Step 1: Gemma Fact Extraction (Total ${articles.length} articles)`);
  for (const article of articles) {
    if (factsResults[article.article_id]) continue;

    console.log(`  Extracting facts for: ${article.title.substring(0, 30)}...`);
    const prompt = PROMPT_TEMPLATE
      .replace('{{TITLE}}', article.title)
      .replace('{{DESCRIPTION}}', article.description);

    let res = await callGemini(GEMMA_MODEL, {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA
      }
    });

    if (!res.success) {
      console.warn(`    Gemma failed, retrying once...`);
      await new Promise(r => setTimeout(r, 5000));
      res = await callGemini(GEMMA_MODEL, {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: "application/json",
          responseSchema: RESPONSE_SCHEMA
        }
      });
    }

    if (res.success) {
      try {
        const text = res.data.candidates[0].content.parts[0].text;
        factsResults[article.article_id] = JSON.parse(text);
        fs.writeFileSync(FACTS_PATH, JSON.stringify(factsResults, null, 2));
      } catch (e) {
        console.error(`  JSON Parse Error for ${article.article_id}: ${e.message}`);
      }
    } else {
      console.error(`  Gemma API Error for ${article.article_id}:`, res.data);
    }
    await new Promise(r => setTimeout(r, 2000));
  }

  // 2. Embedding Generation
  console.log(`Step 2: Embedding Generation`);
  const inputs = ['Raw', 'SubjectOnly', 'FullFact'];
  let embeddings = {};

  for (const article of articles) {
    embeddings[article.article_id] = {};
    const facts = factsResults[article.article_id];

    for (const model of EMBEDDING_MODELS) {
      embeddings[article.article_id][model] = {};
      for (const type of inputs) {
        let inputText = '';
        if (type === 'Raw') {
          inputText = `title: ${article.title}\ndescription: ${article.description}`;
        }

        if (type === 'Raw') {
          const res = await callEmbedding(model, inputText);
          if (res.success) embeddings[article.article_id][model][type] = [res.data.embedding.values];
        } else if (facts && facts.topics) {
          const vecs = [];
          for (const t of facts.topics) {
            let tText = '';
            if (type === 'SubjectOnly') {
              tText = `entity: ${t.subject.entity}\nevent: ${t.subject.event}`;
            } else if (type === 'FullFact') {
              const sub = t.subtopics.join(', ');
              const f = t.facts.map(fact => `- ${fact.type}: ${fact.value}`).join('\n');
              tText = `entity: ${t.subject.entity}\nevent: ${t.subject.event}\nsubtopics: ${sub}\nfacts:\n${f}`;
            }
            const res = await callEmbedding(model, tText);
            if (res.success) vecs.push(res.data.embedding.values);
            await new Promise(r => setTimeout(r, 500));
          }
          embeddings[article.article_id][model][type] = vecs;
        }

        await new Promise(r => setTimeout(r, 500));
      }
    }
  }

  // 3. Similarity Calculation
  console.log(`Step 3: Similarity Calculation`);
  const groups = evalSet.groups;
  const pairResults = [];

  for (let i = 0; i < articles.length; i++) {
    for (let j = i + 1; j < articles.length; j++) {
      const a1 = articles[i];
      const a2 = articles[j];

      let label = 'DIFFERENT';
      const group1 = groups.find(g => g.article_ids.includes(a1.article_id));
      const group2 = groups.find(g => g.article_ids.includes(a2.article_id));

      if (group1 && group2 && group1.group_id === group2.group_id) {
        label = group1.label;
      }

      const pairResult = {
        a1: a1.article_id,
        a2: a2.article_id,
        a1_title: a1.title,
        a2_title: a2.title,
        label: label,
        similarities: {}
      };

      for (const model of EMBEDDING_MODELS) {
        for (const type of inputs) {
          const cond = `${model}_${type}`;
          const vecs1 = embeddings[a1.article_id][model][type];
          const vecs2 = embeddings[a2.article_id][model][type];

          if (vecs1 && vecs2) {
            let maxSim = -1;
            for (const v1 of vecs1) {
              for (const v2 of vecs2) {
                const sim = cosineSimilarity(v1, v2);
                if (sim > maxSim) maxSim = sim;
              }
            }
            pairResult.similarities[cond] = maxSim;
          }
        }
      }
      pairResults.push(pairResult);
    }
  }

  // 4. Statistics and Thresholds
  console.log(`Step 4: Statistics and Thresholds`);
  const summary = {};
  const conds = [];
  for (const model of EMBEDDING_MODELS) {
    for (const type of inputs) {
      conds.push(`${model}_${type}`);
    }
  }

  for (const cond of conds) {
    const samePairs = pairResults.filter(p => p.label === 'SAME').map(p => p.similarities[cond]);
    const diffPairs = pairResults.filter(p => p.label === 'DIFFERENT').map(p => p.similarities[cond]);
    const ambigPairs = pairResults.filter(p => p.label === 'AMBIGUOUS').map(p => p.similarities[cond]);

    const statsFn = (arr) => {
      if (arr.length === 0) return {};
      const sorted = [...arr].sort((a, b) => a - b);
      return {
        count: arr.length,
        mean: arr.reduce((a, b) => a + b, 0) / arr.length,
        median: sorted[Math.floor(sorted.length / 2)],
        min: sorted[0],
        max: sorted[sorted.length - 1]
      };
    };

    summary[cond] = {
      SAME: statsFn(samePairs),
      DIFFERENT: statsFn(diffPairs),
      AMBIGUOUS: statsFn(ambigPairs)
    };

    let bestF1 = 0;
    let bestThreshold = 0;
    let bestMetrics = {};

    for (let t = 0.50; t <= 0.99; t += 0.01) {
      let tp = 0, fp = 0, tn = 0, fn = 0;
      for (const p of pairResults) {
        if (p.label === 'AMBIGUOUS') continue;
        const sim = p.similarities[cond];
        if (sim === undefined) continue;
        const predictedSame = sim >= t;
        const actualSame = p.label === 'SAME';

        if (predictedSame && actualSame) tp++;
        else if (predictedSame && !actualSame) fp++;
        else if (!predictedSame && !actualSame) tn++;
        else if (!predictedSame && actualSame) fn++;
      }

      const precision = tp / (tp + fp) || 0;
      const recall = tp / (tp + fn) || 0;
      const f1 = (2 * precision * recall) / (precision + recall) || 0;

      if (f1 >= bestF1) {
        bestF1 = f1;
        bestThreshold = t;
        bestMetrics = { precision, recall, f1, tp, fp, tn, fn };
      }
    }
    summary[cond].best_threshold = bestThreshold;
    summary[cond].best_metrics = bestMetrics;
  }

  const finalResults = {
    metadata: {
      timestamp: new Date().toISOString(),
      gemma_model: GEMMA_MODEL,
      embedding_models: EMBEDDING_MODELS,
      input_types: inputs,
      api_stats: {
        ...stats,
        gemma_avg_elapsed: stats.gemma_requests ? stats.gemma_elapsed_total / stats.gemma_requests : 0,
        emb_avg_elapsed: (stats.emb1_requests + stats.emb2_requests) ? stats.emb_elapsed_total / (stats.emb1_requests + stats.emb2_requests) : 0
      }
    },
    summary: summary,
    pair_results: pairResults
  };

  fs.writeFileSync(RESULTS_PATH, JSON.stringify(finalResults, null, 2));
  console.log(`Benchmark complete. Results saved to: ${RESULTS_PATH}`);
}

run().catch(err => {
  console.error('Benchmark failed:', err);
});
