import fs from 'fs';
import path from 'path';

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  console.error('Error: GEMINI_API_KEY environment variable is not set.');
  process.exit(1);
}

const MODEL = 'gemma-4-26b-a4b-it';
const OUTPUT_PATH = path.join('tools', 'benchmarks', 'gemma_26b_structured_benchmark_results.json');

const ARTICLES = [
  {
    "title": "iOS 27ベータからカメラ新機能5つ発見。iPhone 18 Proの可変絞りを示唆するものも - Gadget Gate",
    "description": "iOS 27ベータからカメラ新機能5つ発見。iPhone 18 Proの可変絞りを示唆するものも Gadget Gate iOS 27のコードから未公開カメラ機能5つ判明。手動フォーカスはiPhone 18 Proなど新型iPhone限定に GAZLOG iOS27のカメラの新機能!UIや操作性の刷新やSiriモード、RAW9対応など - iPhone Mania iPhone Mania 2台のiPhoneで同じ電話番号を使えるように iOS 27の新機能が便利そう 週刊アスキー 自分のiPhoneで「Siri AI」を使えない理由は? - いまさら聞けないiPhoneのなぜ news.mynavi.jp"
  },
  {
    "title": "「霊長類最強」の可愛い愛犬刺繍入り水色グローブに吉田沙保里さんも「始球式はこのグローブで」",
    "description": "レスリング女子でオリンピック(五輪)金メダリストの吉田沙保里さん(43)が8日までにインスタグラムを更新。グローブをプレゼントされたことを報告した。 ローリングス社のグローブは全面水色で、吉田さんの愛犬リリーの刺繍がウェブ部分に施されて..."
  },
  {
    "title": "【渋谷餃子】「きゅうりのキューちゃん」が餃子に!? 東海漬物と初コラボ!「キューちゃん餃子」など6種の限定メニューが登場",
    "description": "【渋谷餃子】「きゅうりのキューちゃん」が餃子に!? 東海漬物と初コラボ!「キューちゃん餃子」など6種の限定メニューが登場 株式会社SAKIGAKEホールディングスのプレスリリース"
  },
  {
    "title": "復興相苦言「福島に偏見」 福島大やゆ投稿動画(共同通信)",
    "description": "学歴や受験をテーマとするユーチューバーが投稿動画で福島大の研究活動をやゆした問題を巡り、牧野京夫復興相は8日の記者会見で「福島の復興に対するある種の偏見の表れではないか。福島の現状や努力を正確に理解"
  },
  {
    "title": "9日明け方 細い月と木星が大接近 晴れる所はどこ? 観察チャンスは限定的(tenki.jp)",
    "description": "明日9日(水)の明け方、東の低い空で細い月と木星が大接近します。肉眼でも楽しめる注目の天体ショーですが、広い範囲で曇りや雨となり、観察できる所は限られそうです。晴れ間が期待できる地域では、東の空に注目"
  },
  {
    "title": "ホンダ、「二輪安全運転診断アプリ」体験会 Uberも導入した判定機能を実車で試してみた(Car Watch)",
    "description": "世界では年間約119万人が交通事故で亡くなっていて、そのうち四輪車が約26万人、二輪車が約34万人を占める。 本田技研工業は、2050年に向けて「環境」と「安全」に関した目標を掲げているが、安全"
  },
  {
    "title": "M!LK5人が“新曲ダンス初披露”!ロングコートやショートパンツ×ロングブーツ姿でハートポーズも「超かっこいい」「みんなスタイル良いから何着ても王子様」「振り付け最高」 - THE FIRST TIMES",
    "description": "M!LK5人が“新曲ダンス初披露”!ロングコートやショートパンツ×ロングブーツ姿でハートポーズも「超かっこいい」「みんなスタイル良いから何着ても王子様」「振り付け最高」 THE FIRST TIMES Google ニュースで見出しと意見をもっと見る"
  },
  {
    "title": "店舗トイレのカゴを燃やした疑い 近くの火事にも関与をほのめかし 63歳の男を逮捕<福島県福島市>",
    "description": "福島市の店舗でトイレにあったカゴを燃やして壊した疑いで63歳の男が逮捕された。男はその直後に起きた別の火事についても関与をほのめかしているという。器物損壊の疑いで逮捕されたのは、本籍が郡山市で住所不定無職の63歳の男。警察によると、男は9月5日午後3時ごろ、福島市の小売店のトイレにあったかごに火をつけて焼き、壊した疑いがもたれている。店舗からの被害届を受けて捜査を進めていたところ、男が出頭した。男は警察の調べに対し「ライターで火をつけた」などと容疑を認めているという。事件があった約15分後には近くのアパートの駐輪場でも火事があり、警察によると男はこの火事についても関与をほのめかしているという。"
  },
  {
    "title": "高知県と徳島県に線状降水帯発生の半日前予測 気象庁が警戒を呼び掛け(ABCニュース)",
    "description": "気象庁は8日午前11時、高知県と徳島県に線状降水帯半日前予測を出しました。 高知県では8日夕方から9日昼前にかけて、徳島県では8日夜遅くから9日昼前にかけて線状降水帯が発生し、大雨災害が発生する"
  },
  {
    "title": "ノルウェーSWFが米債削減、日本国債増額|大橋ひろこ - note",
    "description": "ノルウェーSWFが米債削減、日本国債増額|大橋ひろこ note ノルウェー政府系基金、米国債保有12兆円減少へ 投資基準を見直し 日本経済新聞 日本国債の保有引き上げ=ノルウェー政府系ファンド(時事通信) Yahoo!ファイナンス ノルウェー政府系ファンド、日本国債の保有割合引き上げ方針 時事ドットコム ノルウェー政府系ファンド、米国債を大幅削減方針 資産構成を変更 Reuters"
  }
];

const PROMPT_TEMPLATE = `あなたはニュース記事からファクトデータを抽出する専門家です。
与えられたニュースの「title」と「description」から情報を抽出し、指定されたJSON形式で出力してください。

【抽出ルール】
1. titleとdescriptionに明記されている情報だけを使用してください。
2. 推測禁止。一般知識による補完禁止。元記事にない事実を追加しない。
3. 数字、日付、金額、固有名詞を正確に保持する。
4. 不明な情報を無理に埋めない。
5. 主題(subject)は「対象(entity) + 主要イベント(event)」。
6. 同じ対象でも主要イベントが異なれば別topicになり得ます。
   例：「新型スマホX + 発売」と「新型スマホX + 発売延期」は別topicです。
7. 単なる細部の違いは別topicにしない。価格、発売日、予約開始など、主要イベントに付随する情報は原則subtopic/factsに含める。
8. 1記事内に独立した主要イベントが複数存在する場合だけtopicsを複数生成する。無意味にtopicを細分化しない。
9. JSON以外を返さないでください（Markdownの装飾も不要です）。

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

async function callGemini(model, prompt, config = {}) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${API_KEY}`;
  const start = Date.now();
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.1,
          ...config
        }
      })
    });

    const elapsed = Date.now() - start;
    if (!response.ok) {
      const errorData = await response.json();
      return { success: false, elapsed, error: errorData };
    }

    const data = await response.json();
    return { success: true, elapsed, data };
  } catch (error) {
    return { success: false, elapsed: Date.now() - start, error: error.message };
  }
}

async function runBenchmark() {
  const conditions = [
    {
      id: "Baseline_NewSchema",
      description: "Structured Output: No, Thinking: Default",
      config: {
        responseMimeType: "application/json"
      }
    },
    {
      id: "StructuredOutput",
      description: "Structured Output: Yes, Thinking: Default",
      config: {
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA
      }
    },
    {
      id: "StructuredOutput_NoThinking",
      description: "Structured Output: Yes, Thinking: includeThoughts=false",
      config: {
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
        thinkingConfig: {
          includeThoughts: false
        }
      }
    }
  ];

  let results = {
    metadata: {
      timestamp: new Date().toISOString(),
      model: MODEL,
      conditions: conditions.map(c => ({ id: c.id, description: c.description }))
    },
    articles: []
  };

  if (fs.existsSync(OUTPUT_PATH)) {
    try {
      results = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8'));
    } catch (e) {
      console.warn("Could not parse existing results, starting fresh.");
    }
  }

  for (let i = 0; i < ARTICLES.length; i++) {
    const article = ARTICLES[i];
    if (results.articles.some(a => a.index === i && Object.keys(a.runs).length === conditions.length)) {
      console.log(`Skipping article ${i + 1}: ${article.title.substring(0, 30)}... (already processed)`);
      continue;
    }

    console.log(`Processing article ${i + 1}/${ARTICLES.length}: ${article.title.substring(0, 30)}...`);

    const prompt = PROMPT_TEMPLATE
      .replace('{{TITLE}}', article.title)
      .replace('{{DESCRIPTION}}', article.description);

    let articleResult = results.articles.find(a => a.index === i);
    if (!articleResult) {
      articleResult = {
        index: i,
        title: article.title,
        runs: {}
      };
      results.articles.push(articleResult);
    }

    for (const condition of conditions) {
      if (articleResult.runs[condition.id]) continue;

      console.log(`  Condition: ${condition.id}...`);

      const res = await callGemini(MODEL, prompt, condition.config);

      const metrics = {
        success: res.success,
        elapsed_ms: res.elapsed,
        json_valid: false,
        result: null,
        prompt_tokens: 0,
        output_tokens: 0,
        thought_tokens: 0,
        total_tokens: 0,
        structured_output_used: !!condition.config.responseSchema,
        thinking_config: condition.config.thinkingConfig || "default"
      };

      if (res.success) {
        const candidate = res.data.candidates?.[0];
        const text = candidate?.content?.parts?.[0]?.text;
        metrics.raw_output = text;

        try {
          let jsonStr = text.trim();
          if (jsonStr.startsWith('```')) {
            jsonStr = jsonStr.replace(/^```json\s*/, '').replace(/^```\s*/, '').replace(/\s*```$/, '');
          }
          metrics.result = JSON.parse(jsonStr);
          metrics.json_valid = true;
        } catch (e) {
          metrics.json_valid = false;
          metrics.parse_error = e.message;
        }

        const usage = res.data.usageMetadata;
        metrics.prompt_tokens = usage?.promptTokenCount || 0;
        metrics.output_tokens = usage?.candidatesTokenCount || 0;
        metrics.thought_tokens = usage?.thoughtsTokenCount || 0;
        metrics.total_tokens = usage?.totalTokenCount || 0;
      } else {
        metrics.error = res.error;
      }

      articleResult.runs[condition.id] = metrics;
      fs.writeFileSync(OUTPUT_PATH, JSON.stringify(results, null, 2));

      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }

  console.log(`\nBenchmark complete. Results saved to: ${OUTPUT_PATH}`);
}

runBenchmark().catch(err => {
  console.error('Benchmark failed:', err);
});
