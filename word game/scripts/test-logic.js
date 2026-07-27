// Logic tests for the play-validation rules in index.html.
//
// The syntax gate (check-syntax.js) only proves the bundle parses. It cannot see a scope
// error or a wrong board being read -- both of which have shipped. These tests pull the pure
// functions straight out of index.html and run them against hand-built board positions, so a
// regression in the swap/steal rules fails the build instead of reaching TestFlight.
//
// A small word list is injected on purpose: this exercises the validation rules, not the
// real dictionary, which loads asynchronously at runtime.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

// Pull a top-level `function name(...) {...}` out of the page by walking its braces.
function grabFunction(name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) throw new Error('function not found in index.html: ' + name);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error('unterminated function in index.html: ' + name);
}

// Pull an inclusive run of lines, matched by the text they contain.
function grabLines(startMarker, endMarker) {
  const lines = src.split('\n');
  const a = lines.findIndex(l => l.includes(startMarker));
  if (a === -1) throw new Error('marker not found in index.html: ' + startMarker);
  const b = lines.findIndex((l, i) => i >= a && l.includes(endMarker));
  return lines.slice(a, b + 1).join('\n');
}

const ctx = {
  BS: 15,
  board: null,
  pendingPlacements: {},
  pendingRemovals: new Set(),
  swapPendingPositions: new Set(),
  WORDS: new Set(['AZO','ABO','BO','ZA','AB','OB','DOME','DOMED','CAT','AT','ATE']),
  console,
};
vm.createContext(ctx);
vm.runInContext([
  'const BS = 15;',
  grabLines('const PREMIUM = {}', "PREMIUM['7,7']"),
  grabLines('const VAL = {', 'const VAL = {'),
  grabFunction('boardWithPending'),
  grabFunction('getWordAt'),
  grabFunction('getWordsFormed'),
  grabFunction('hasAdjacentTile'),
  grabFunction('hasGaps'),
  grabFunction('isBoardConnected'),
  grabFunction('scoreWords'),
  grabFunction('scorePlay'),
  grabFunction('validatePlay'),
  'function isEmpty(){ return board.every(r => r.every(c => !c)); }',
].join('\n'), ctx);

let passed = 0;
const failures = [];

// tiles: [row, col, letter] already committed to the board.
// placements/removals/swaps: the pending state for the turn under test.
function check(name, position, expect) {
  const b = Array.from({ length: 15 }, () => Array(15).fill(null));
  for (const [r, c, letter] of position.tiles) b[r][c] = letter;
  ctx.board = b;
  ctx.pendingPlacements = position.placements;
  ctx.pendingRemovals = new Set(position.removals || []);
  ctx.swapPendingPositions = new Set(position.swaps || []);

  const res = ctx.validatePlay(position.placements, new Set(position.swaps || []));
  const ok = expect.allowed
    ? res.ok
    : !res.ok && (res.err || '').includes(expect.errorContains);

  if (ok) { passed++; console.log('  pass  ' + name); return; }
  failures.push(name);
  console.log('  FAIL  ' + name);
  console.log('          expected: ' + (expect.allowed ? 'allowed' : `rejected containing "${expect.errorContains}"`));
  console.log('          actual:   ' + JSON.stringify(res.ok ? { ok: true, words: res.words.map(w => w.word) } : res));
}

console.log('\nPlay validation — swap and steal\n');

// A swap records only pendingPlacements, never pendingRemovals. Validating the steal against
// the committed board therefore read the pre-swap letter: swapping B onto the Z of AZO and
// stealing the A rejected the play as "ZO" when column 7 actually reads BO.
check('swap onto a word, then steal from it, leaves a valid word', {
  tiles: [[0,7,'A'], [1,7,'Z'], [2,7,'O'], [2,8,'B']],
  placements: {
    '1,7': { letter: 'B', rackIdx: 0, isSwap: true },
    '0,6': { letter: 'Z', rackIdx: 1 },
    '1,6': { letter: 'A', rackIdx: 2 },
  },
  removals: ['0,7'],
  swaps: ['1,7'],
}, { allowed: true });

// The same steal without the swap really does leave ZO, and must stay rejected -- the fix
// above must not make the validator permissive.
check('same steal without the swap is still rejected', {
  tiles: [[0,7,'A'], [1,7,'Z'], [2,7,'O'], [2,8,'B']],
  placements: {
    '0,6': { letter: 'C', rackIdx: 1 },
    '1,6': { letter: 'A', rackIdx: 2 },
  },
  removals: ['0,7'],
}, { allowed: false, errorContains: 'ZO' });

check('taking the trailing D of DOMED leaves DOME', {
  tiles: [[5,4,'D'], [5,5,'O'], [5,6,'M'], [5,7,'E'], [5,8,'D'], [6,7,'A']],
  placements: {
    '6,8': { letter: 'T', rackIdx: 0 },
    '6,9': { letter: 'E', rackIdx: 1 },
  },
  removals: ['5,8'],
}, { allowed: true });

check('a steal that leaves a non-word is rejected', {
  tiles: [[5,4,'D'], [5,5,'O'], [5,6,'M'], [5,7,'E'], [6,6,'A']],
  placements: { '6,7': { letter: 'T', rackIdx: 0 } },
  removals: ['5,4'],
}, { allowed: false, errorContains: 'not a valid word' });

console.log('\nScoring — replayed tiles keep their square bonuses\n');

// Reported position: AZO down column 8, B swapped onto the Z, A stolen, then the Z and A
// replayed at (0,7)=DL and (1,7)=DW. Both replayed tiles came off the board, and both must
// still earn their new square's bonus: ZA = ((10x2)+1)x2 = 42, AB = 4x2 = 8, BO = 0 because
// it is formed only by the swapped tile. Total 50. Denying replayed tiles their letter
// bonus scored this 30.
(function scoringCase() {
  const b = Array.from({ length: 15 }, () => Array(15).fill(null));
  b[0][8] = 'A'; b[1][8] = 'Z'; b[2][8] = 'O';
  b[2][9] = 'B'; b[2][10] = 'A';
  b[3][9] = 'A'; b[3][10] = 'R';
  ctx.board = b;
  ['OBA', 'AR'].forEach(w => ctx.WORDS.add(w));

  const placements = {
    '1,8': { letter: 'B', rackIdx: 0, isSwap: true },
    '0,7': { letter: 'Z', rackIdx: 1 },
    '1,7': { letter: 'A', rackIdx: 2 },
  };
  ctx.pendingPlacements = placements;
  ctx.pendingRemovals = new Set(['0,8']);
  ctx.swapPendingPositions = new Set(['1,8']);
  ctx.swappedRackIndices = new Set([1, 2]);

  const swapKeys = new Set(['1,8']);
  const res = ctx.validatePlay(placements, swapKeys);
  if (!res.ok) {
    failures.push('scoring position is playable');
    console.log('  FAIL  scoring position is playable');
    console.log('          rejected: ' + res.err);
    return;
  }
  // Go through scorePlay, the single place that decides premium exemptions, so this test
  // fails if that rule changes — calling scoreWords directly would just restate the rule.
  const total = ctx.scorePlay(res.words, new Set(Object.keys(placements)), swapKeys);
  if (total === 50) { passed++; console.log('  pass  swap + steal + replay scores 50'); }
  else {
    failures.push('swap + steal + replay scores 50');
    console.log('  FAIL  swap + steal + replay scores 50');
    console.log('          expected: 50');
    console.log('          actual:   ' + total + '  (words: ' + res.words.map(w => w.word).join(', ') + ')');
  }
})();

if (failures.length) {
  console.error(`\nLogic tests failed (${failures.length} of ${passed + failures.length}). Build stopped.\n`);
  process.exit(1);
}
console.log(`\nLogic tests passed (${passed}).\n`);
