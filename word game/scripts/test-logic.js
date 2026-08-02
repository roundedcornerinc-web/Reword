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
  grabFunction('getRemovableInfo'),
  grabFunction('earnsAllTilesBonus'),
  grabFunction('buildReplayFrames'),
  grabFunction('buildSwapPairing'),
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

console.log('\nSteal eligibility — getRemovableInfo\n');

// tiles: committed board. placements: tiles already laid out this turn. [r,c]: the steal target.
function checkSteal(name, position, expect) {
  const b = Array.from({ length: 15 }, () => Array(15).fill(null));
  for (const [r, c, letter] of position.tiles) b[r][c] = letter;
  ctx.board = b;
  ctx.pendingPlacements = position.placements || {};
  ctx.pendingRemovals = new Set(position.removals || []);
  ctx.swapPendingPositions = new Set(position.swaps || []);

  const res = ctx.getRemovableInfo(position.at[0], position.at[1]);
  const ok = expect.removable
    ? res.removable
    : !res.removable && (res.reason || '').includes(expect.reasonContains);
  if (ok) { passed++; console.log('  pass  ' + name); return; }
  failures.push(name);
  console.log('  FAIL  ' + name);
  console.log('          expected: ' + (expect.removable ? 'removable' : `blocked containing "${expect.reasonContains}"`));
  console.log('          actual:   ' + JSON.stringify(res));
}

['CARS', 'CAR', 'TEA', 'TEAS', 'ART', 'TAR'].forEach(w => ctx.WORDS.add(w));
const CARS = [[7,5,'C'], [7,6,'A'], [7,7,'R'], [7,8,'S']];

// Reported bug: tiles laid out for the word you're building are still floating mid-turn, so
// the connectivity check blamed the steal for a disconnection it did not cause. Laying out
// T-E-A and then stealing the S to finish TEAS is the natural order of operations.
checkSteal('steal is allowed while this turn\'s tiles are still unconnected', {
  tiles: CARS,
  at: [7, 8],
  placements: {
    '10,5': { letter: 'T', rackIdx: 0 },
    '10,6': { letter: 'E', rackIdx: 1 },
    '10,7': { letter: 'A', rackIdx: 2 },
  },
}, { removable: true });

// The relaxation must not make the steal rules permissive generally: this turn's tiles are
// ignored only for connectivity, and every other rule still reads the effective board.
checkSteal('this turn\'s tiles still make a tile a two-word junction', {
  tiles: CARS,
  at: [7, 8],
  placements: { '8,8': { letter: 'O', rackIdx: 0 }, '9,8': { letter: 'N', rackIdx: 1 } },
}, { removable: false, reasonContains: 'connects two words' });

checkSteal('a steal leaving a non-word is still blocked', {
  tiles: CARS,
  at: [7, 5],
}, { removable: false, reasonContains: 'not a valid word' });

console.log('\nAll-tiles bonus — a stolen tile is not one of your seven\n');

// rackSize counts the rack at submit time, which a steal has already grown by one.
function checkBonus(name, rackSize, placedFromRack, stolen, expected) {
  const got = !!ctx.earnsAllTilesBonus(rackSize, placedFromRack, stolen);
  if (got === expected) { passed++; console.log('  pass  ' + name); return; }
  failures.push(name);
  console.log('  FAIL  ' + name);
  console.log('          expected: ' + expected + '   actual: ' + got);
}

checkBonus('emptying a full 7-tile rack earns it', 7, 7, 0, true);
// Reported: 6 tiles left plus a stolen letter is a 7-tile play, but only 6 came from the
// bag, so the rack was never full — placements alone paid the bonus here.
checkBonus('six own tiles plus a stolen one does not', 7, 7, 1, false);
checkBonus('a full rack plus a stolen tile, all placed, earns it', 8, 8, 1, true);
checkBonus('leaving a tile behind does not', 7, 6, 0, false);
checkBonus('a short endgame rack does not', 5, 5, 0, false);
// A swap trades a rack tile for a board tile, so the rack size never changes and the
// bonus is unaffected — the swapped-in tile still has to be placed.
checkBonus('swapping does not disturb the bonus', 7, 7, 0, true);

console.log('\nLast-move replay — pairing, then reconstruction\n');

// These drive the real producer. The first version of these tests hand-wrote the pair map
// the way the AI commit path writes it, which is not what a human turn produces — so they
// passed while a replayed steal showed the stolen tile appearing from nowhere.
//
// A turn is described the way submitPlay holds it: placements keyed by square, removals
// keyed by the square a tile was stolen from, and the rack slots those tiles landed in.
function replayTurn(position) {
  const swapKeys = new Set(Object.keys(position.placements).filter(k => position.placements[k].isSwap));
  const swappedIdx = new Set(position.swappedIdx || []);
  const pairing = ctx.buildSwapPairing(position.placements, position.removals || {}, swapKeys, swappedIdx);

  // Apply the turn to the board, exactly as submitPlay does, to get the "after" position.
  const after = Array.from({ length: 15 }, () => Array(15).fill(null));
  for (const [r, c, letter] of position.tiles) after[r][c] = letter;
  for (const [key, p] of Object.entries(position.placements)) {
    const [r, c] = key.split(',').map(Number);
    after[r][c] = p.letter;
  }
  for (const key of Object.keys(position.removals || {})) {
    const [r, c] = key.split(',').map(Number);
    after[r][c] = null;
  }

  ctx.board = after;
  ctx.lastMoveKeys = Object.keys(position.placements).filter(k => !position.placements[k].isSwap).sort();
  ctx.lastSwapKeys = pairing.keys;
  ctx.lastSwapPairMap = pairing.pairMap;
  return ctx.buildReplayFrames();
}

function checkReplay(name, position, expect) {
  const frames = replayTurn(position);
  const read = cells => cells.map(([r, c]) => frames.pre[r][c] || '.').join('');
  let problem = null;
  if (read(expect.cells) !== expect.word)
    problem = `before-board read "${read(expect.cells)}", expected "${expect.word}"`;
  else if (expect.rackKeys && frames.rackKeys.join(',') !== expect.rackKeys.join(','))
    problem = `rack tiles were [${frames.rackKeys}], expected [${expect.rackKeys}]`;
  if (!problem) { passed++; console.log('  pass  ' + name); return; }
  failures.push(name);
  console.log('  FAIL  ' + name);
  console.log('          ' + problem);
}

// Steal: CARS on row 7; the S is taken into rack slot 3 and played as the last letter of
// TEAS. The replay must put the S back on 7,8 and not treat it as an ordinary rack tile.
checkReplay('a stolen tile is paired with where it was played', {
  tiles: [[7,5,'C'], [7,6,'A'], [7,7,'R'], [7,8,'S']],
  removals: { '7,8': { rackIdx: 3 } },
  placements: {
    '10,4': { letter: 'T', rackIdx: 0 },
    '10,5': { letter: 'E', rackIdx: 1 },
    '10,6': { letter: 'A', rackIdx: 2 },
    '10,7': { letter: 'S', rackIdx: 3 },
  },
  swappedIdx: [3],
}, { cells: [[7,5],[7,6],[7,7],[7,8]], word: 'CARS', rackKeys: ['10,4', '10,5', '10,6'] });

// Swap: a B from rack slot 0 goes onto the C of CARS, and the displaced C comes back on the
// same slot and is played in COT.
checkReplay('a swapped-out tile is paired with where it was played', {
  tiles: [[7,5,'C'], [7,6,'A'], [7,7,'R'], [7,8,'S']],
  placements: {
    '7,5':  { letter: 'B', rackIdx: 0, isSwap: true },
    '10,4': { letter: 'C', rackIdx: 0 },
    '10,5': { letter: 'O', rackIdx: 1 },
    '10,6': { letter: 'T', rackIdx: 2 },
  },
  swappedIdx: [0],
}, { cells: [[7,5],[7,6],[7,7],[7,8]], word: 'CARS', rackKeys: ['10,5', '10,6'] });

// A swap and a steal in the same turn — the shade indices must not cross the pairs over.
checkReplay('a swap and a steal together keep their own partners', {
  tiles: [[7,5,'C'], [7,6,'A'], [7,7,'R'], [7,8,'S'], [3,5,'D'], [3,6,'O'], [3,7,'M'], [3,8,'E']],
  removals: { '3,8': { rackIdx: 5 } },
  placements: {
    '7,5':  { letter: 'B', rackIdx: 0, isSwap: true },
    '10,4': { letter: 'C', rackIdx: 0 },
    '10,5': { letter: 'E', rackIdx: 5 },
    '10,6': { letter: 'T', rackIdx: 2 },
  },
  swappedIdx: [0, 5],
}, { cells: [[3,5],[3,6],[3,7],[3,8]], word: 'DOME', rackKeys: ['10,6'] });

checkReplay('and the swapped word too', {
  tiles: [[7,5,'C'], [7,6,'A'], [7,7,'R'], [7,8,'S'], [3,5,'D'], [3,6,'O'], [3,7,'M'], [3,8,'E']],
  removals: { '3,8': { rackIdx: 5 } },
  placements: {
    '7,5':  { letter: 'B', rackIdx: 0, isSwap: true },
    '10,4': { letter: 'C', rackIdx: 0 },
    '10,5': { letter: 'E', rackIdx: 5 },
    '10,6': { letter: 'T', rackIdx: 2 },
  },
  swappedIdx: [0, 5],
}, { cells: [[7,5],[7,6],[7,7],[7,8]], word: 'CARS' });

console.log('\nLast-move replay — reconstructing the board before the move\n');

// The replay stores nothing of its own: it rebuilds the previous position from the current
// board plus lastMoveKeys/lastSwapKeys/lastSwapPairMap. If that reconstruction is wrong the
// replay silently shows a position that never existed, which no parse or play check sees.
function replayCase(name, position) {
  const b = Array.from({ length: 15 }, () => Array(15).fill(null));
  for (const [r, c, letter] of position.tiles) b[r][c] = letter;
  ctx.board = b;
  ctx.lastMoveKeys = position.moveKeys;
  ctx.lastSwapKeys = position.swapKeys || [];
  ctx.lastSwapPairMap = position.pairMap || {};
  const frames = ctx.buildReplayFrames();
  const read = cells => cells.map(([r, c]) => frames.pre[r][c] || '.').join('');

  let problem = null;
  if (position.before && read(position.before.cells) !== position.before.word)
    problem = `before-board read "${read(position.before.cells)}", expected "${position.before.word}"`;
  else if (position.rackKeys && frames.rackKeys.join(',') !== position.rackKeys.join(','))
    problem = `rack tiles were [${frames.rackKeys}], expected [${position.rackKeys}]`;

  if (!problem) { passed++; console.log('  pass  ' + name); return; }
  failures.push(name);
  console.log('  FAIL  ' + name);
  console.log('          ' + problem);
}

// Steal: CARS stood on row 7; the S was taken and played as the last letter of TEAS.
replayCase('a steal puts the stolen letter back where it came from', {
  tiles: [[7,5,'C'], [7,6,'A'], [7,7,'R'],
          [10,4,'T'], [10,5,'E'], [10,6,'A'], [10,7,'S']],
  moveKeys: ['10,4', '10,5', '10,6', '10,7'],
  swapKeys: ['7,8'],
  pairMap: { '7,8': 0, '10,7': 0 },
  before: { cells: [[7,5],[7,6],[7,7],[7,8]], word: 'CARS' },
  rackKeys: ['10,4', '10,5', '10,6'],   // the stolen S replays as a steal, not a rack tile
});

// Swap: a B was played onto the C of CARS, and the displaced C became the C of COT.
replayCase('a swap restores the letter that was covered', {
  tiles: [[7,5,'B'], [7,6,'A'], [7,7,'R'], [7,8,'S'],
          [10,4,'C'], [10,5,'O'], [10,6,'T']],
  moveKeys: ['10,4', '10,5', '10,6'],
  swapKeys: ['7,5'],
  pairMap: { '7,5': 0, '10,4': 0 },
  before: { cells: [[7,5],[7,6],[7,7],[7,8]], word: 'CARS' },
  rackKeys: ['10,5', '10,6'],
});

replayCase('a plain move leaves an empty before-board', {
  tiles: [[7,5,'C'], [7,6,'A'], [7,7,'R']],
  moveKeys: ['7,5', '7,6', '7,7'],
  before: { cells: [[7,5],[7,6],[7,7]], word: '...' },
  rackKeys: ['7,5', '7,6', '7,7'],
});

// Two steals in one turn — the pair map has to keep the sources and destinations straight.
const twoSteals = {
  tiles: [[7,5,'C'], [7,6,'A'], [7,7,'R'],
          [3,5,'D'], [3,6,'O'], [3,7,'M'],
          [10,4,'S'], [10,5,'E'], [10,6,'A'], [10,7,'T']],
  moveKeys: ['10,4', '10,5', '10,6', '10,7'],
  swapKeys: ['7,8', '3,8'],
  pairMap: { '7,8': 0, '10,4': 0, '3,8': 1, '10,5': 1 },
};
replayCase('two steals restore the first word',
  { ...twoSteals, before: { cells: [[7,5],[7,6],[7,7],[7,8]], word: 'CARS' } });
replayCase('two steals restore the second word, and only two tiles came from the rack',
  { ...twoSteals, before: { cells: [[3,5],[3,6],[3,7],[3,8]], word: 'DOME' },
    rackKeys: ['10,6', '10,7'] });

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
