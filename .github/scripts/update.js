// .github/scripts/update.js
// Reads index.html, sends it + your GitHub issue text to Gemini,
// and overwrites index.html with the returned full updated code.

const fs = require('fs');
const path = require('path');

const FILE_TO_UPDATE = 'index.html'; // change this if your main file has a different name

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  const issueTitle = process.env.ISSUE_TITLE || '';
  const issueBody = process.env.ISSUE_BODY || '';
  // Use the body if present, otherwise fall back to the title (minus the [ai] tag)
  const requestText = issueBody.trim() || issueTitle.replace(/\[ai\]/i, '').trim();

  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set');
  }
  if (!requestText) {
    throw new Error('Issue has no title or body text — describe the change you want.');
  }

  const filePath = path.join(process.cwd(), FILE_TO_UPDATE);
  const currentCode = fs.readFileSync(filePath, 'utf8');

  const prompt = `You are editing a single-file web app (${FILE_TO_UPDATE}).

Here is the current full code:

\`\`\`html
${currentCode}
\`\`\`

Requested change:
"${requestText}"

Return ONLY the complete updated file content, from the very first line to the very last line.
Do not include any explanation, markdown fences, or commentary — just the raw file content, ready to save directly as ${FILE_TO_UPDATE}.`;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
      }),
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini API error: ${response.status} ${errText}`);
  }

  const data = await response.json();
  let updatedCode = data?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!updatedCode) {
    throw new Error('Gemini did not return usable content.');
  }

  // Strip accidental markdown code fences if Gemini adds them anyway
  updatedCode = updatedCode
    .replace(/^```[a-zA-Z]*\n/, '')
    .replace(/```\s*$/, '')
    .trim();

  fs.writeFileSync(filePath, updatedCode, 'utf8');
  console.log(`Updated ${FILE_TO_UPDATE} (${updatedCode.length} chars written).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
