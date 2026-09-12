// .github/scripts/update.js
// Reads the target file(s), sends each + your GitHub issue text to Gemini,
// and overwrites the file with the returned full updated code.
//
// Target is chosen from the issue title tag:
//   [ai] or [ai-user]  -> index.html
//   [ai-admin]         -> admin.html
//   [ai-both]          -> index.html AND admin.html (same instruction applied to each)

const fs = require('fs');
const path = require('path');

function getTargetFiles(issueTitle) {
  const title = issueTitle.toLowerCase();
  if (title.includes('[ai-both]')) return ['index.html', 'admin.html'];
  if (title.includes('[ai-admin]')) return ['admin.html'];
  if (title.includes('[ai-user]') || title.includes('[ai]')) return ['index.html'];
  // Fallback: default to index.html so old-style issues still work
  return ['index.html'];
}

async function updateFile(fileName, requestText, apiKey) {
  const filePath = path.join(process.cwd(), fileName);
  const currentCode = fs.readFileSync(filePath, 'utf8');

  const prompt = `You are editing a single-file web app (${fileName}).

Here is the current full code:

\`\`\`html
${currentCode}
\`\`\`

Requested change:
"${requestText}"

Return ONLY the complete updated file content, from the very first line to the very last line.
Do not include any explanation, markdown fences, or commentary — just the raw file content, ready to save directly as ${fileName}.`;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${apiKey}`,
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
    throw new Error(`Gemini API error for ${fileName}: ${response.status} ${errText}`);
  }

  const data = await response.json();
  let updatedCode = data?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!updatedCode) {
    throw new Error(`Gemini did not return usable content for ${fileName}.`);
  }

  // Strip accidental markdown code fences if Gemini adds them anyway
  updatedCode = updatedCode
    .replace(/^```[a-zA-Z]*\n/, '')
    .replace(/```\s*$/, '')
    .trim();

  fs.writeFileSync(filePath, updatedCode, 'utf8');
  console.log(`Updated ${fileName} (${updatedCode.length} chars written).`);
}

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  const issueTitle = process.env.ISSUE_TITLE || '';
  const issueBody = process.env.ISSUE_BODY || '';

  // Use the body if present, otherwise fall back to the title (minus the tag)
  const requestText = issueBody.trim() || issueTitle.replace(/\[ai[-a-z]*\]/i, '').trim();

  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set');
  }
  if (!requestText) {
    throw new Error('Issue has no title or body text — describe the change you want.');
  }

  const targets = getTargetFiles(issueTitle);
  console.log(`Target file(s) for this issue: ${targets.join(', ')}`);

  for (const fileName of targets) {
    await updateFile(fileName, requestText, apiKey);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
