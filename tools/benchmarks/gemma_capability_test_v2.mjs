import fs from 'fs';

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = 'gemma-4-26b-a4b-it';

async function testCapability(description, config) {
  console.log(`Testing: ${description}...`);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: "Extract topic from: 'New iPhone 18 released today'" }] }],
        generationConfig: config
      })
    });
    const data = await response.json();
    if (response.ok) {
      console.log(`  Success!`);
      return { success: true, data };
    } else {
      console.log(`  Failed: ${response.status} ${response.statusText}`);
      console.log(JSON.stringify(data, null, 2));
      return { success: false, data };
    }
  } catch (error) {
    console.log(`  Error: ${error.message}`);
    return { success: false, error: error.message };
  }
}

async function run() {
  // Try includeThoughts only
  await testCapability("Thinking Config (includeThoughts only)", {
    thinkingConfig: {
      includeThoughts: false
    }
  });

  // Try thought_tokens limit if any? (Likely not)
}

run();
