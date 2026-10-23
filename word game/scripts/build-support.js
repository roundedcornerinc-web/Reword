// Builds the FAQ section of support.html from the in-app FAQ in index.html, so the support page
// and the game never say different things. Run by `npm run sync` (before the tests). The FAQ is
// the one in #faq-body; everything between the FAQ:START and FAQ:END markers in support.html is
// replaced, and nothing else in that file is touched.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const START = '<!-- FAQ:START (generated from index.html by scripts/build-support.js; edit the FAQ there) -->';
const END = '<!-- FAQ:END -->';

function faqHtml(indexSrc) {
  const open = '<div id="faq-body">';
  const a = indexSrc.indexOf(open);
  if (a === -1) throw new Error('#faq-body not found in index.html');
  const from = a + open.length;
  // #faq-body closes with the panel and overlay: three closing divs at 4, 2 and 0 spaces.
  const to = indexSrc.indexOf('\n    </div>\n  </div>\n</div>', from);
  if (to === -1) throw new Error('end of #faq-body not found in index.html');
  const items = indexSrc.slice(from, to).trim();
  if (!items.includes('class="faq-item"')) throw new Error('no FAQ items found');
  return items.split('\n').map(l => (l.trim() ? '  ' + l.replace(/^ {0,6}/, '') : '')).join('\n');
}

function build() {
  const support = fs.readFileSync(path.join(root, 'support.html'), 'utf8');
  const a = support.indexOf(START), b = support.indexOf(END);
  if (a === -1 || b === -1 || b < a) throw new Error('FAQ markers not found in support.html');
  const faq = faqHtml(fs.readFileSync(path.join(root, 'index.html'), 'utf8'));
  return support.slice(0, a + START.length) + '\n' + faq + '\n' + support.slice(b);
}

module.exports = { build, faqHtml };

if (require.main === module) {
  const next = build();
  const file = path.join(root, 'support.html');
  if (next !== fs.readFileSync(file, 'utf8')) { fs.writeFileSync(file, next); console.log('support.html FAQ updated from index.html'); }
  else console.log('support.html FAQ already up to date');
}
