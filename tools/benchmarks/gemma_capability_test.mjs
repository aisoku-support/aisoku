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
      // console.log(JSON.stringify(data.usageMetadata, null, 2));
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
  // 1. JSON MIME Type only
  await testCapability("JSON MIME Type only", {
    responseMimeType: "application/json"
  });

  // 2. Structured Output (Response Schema)
  await testCapability("Structured Output (Response Schema)", {
    responseMimeType: "application/json",
    responseSchema: {
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
                }
              }
            }
          }
        }
      }
    }
  });

  // 3. Thinking Budget (Minimal)
  // Gemini 2.0 uses 'thinkingConfig'. Let's see if Gemma 4 supports it.
  await testCapability("Thinking Budget (Thinking Config)", {
    thinkingConfig: {
      includeThoughts: true,
      thoughtBudget: 1024
    }
  });

  // 4. Thinking Budget (Very Small)
  await testCapability("Thinking Budget (Thinking Config - Small)", {
    thinkingConfig: {
      includeThoughts: true,
      thoughtBudget: 32
    }
  });
}

run();
