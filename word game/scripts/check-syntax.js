// Parses every inline <script> block in index.html and fails the build on a
// syntax error. The whole app lives in one <script>, so a single stray
// character (an unescaped apostrophe, a missing brace) stops the entire block
// from executing and the app boots to a blank purple screen with no console
// error to point at it. Cheap to run, catches the whole class of failure.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const file = path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(file, 'utf8');

const blocks = /<script([^>]*)>([\s\S]*?)<\/script>/g;
let match;
let checked = 0;
let failed = 0;

while ((match = blocks.exec(html))) {
  const [, attrs, body] = match;
  if (/\bsrc=/.test(attrs)) continue; // external, nothing inline to parse

  const startLine = html.slice(0, match.index).split('\n').length;
  checked++;

  try {
    new vm.Script(body, { filename: 'inline-script' });
  } catch (e) {
    failed++;
    const where = /inline-script:(\d+)/.exec(e.stack || '');
    const line = where ? startLine + parseInt(where[1], 10) - 1 : startLine;
    console.error(`\nindex.html:${line}  ${e.message}`);
    console.error(`  ${html.split('\n')[line - 1].trim()}`);
  }
}

if (failed) {
  console.error(`\nSyntax check failed (${failed} of ${checked} inline blocks). Build stopped.\n`);
  process.exit(1);
}

console.log(`Syntax check passed (${checked} inline script blocks).`);
