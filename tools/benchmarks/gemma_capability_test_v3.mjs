import fs from 'fs';

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = 'gemma-4-26b-a4b-it';

async function testUsage(description, config) {
  console.log(`Testing: ${description}...`);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;
  const start = Date.now();
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: "Extract topic from: 'New iPhone 18 released today'" }] }],
        generationConfig: config
      })
    });
    const elapsed = Date.now() - start;
    const data = await response.json();
    if (response.ok) {
      console.log(`  Success! Elapsed: ${elapsed}ms`);
      console.log(`  Usage: ${JSON.stringify(data.usageMetadata)}`);
      return { success: true, data };
    } else {
      console.log(`  Failed: ${response.status} ${response.statusText}`);
      return { success: false, data };
    }
  } catch (error) {
    console.log(`  Error: ${error.message}`);
    return { success: false, error: error.message };
  }
}

async function run() {
  await testUsage("Baseline (default thinking)", {
    responseMimeType: "application/json"
  });

  await testUsage("Thinking Config (includeThoughts: false)", {
    responseMimeType: "application/json",
    thinkingConfig: {
      includeThoughts: false
    }
  });

  await testUsage("Thinking Config (includeThoughts: true)", {
    responseMimeType: "application/json",
    thinkingConfig: {
      includeThoughts: true
    }
  });
}

run();
