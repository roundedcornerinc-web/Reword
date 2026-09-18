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
  WORDS: new Set(['AZO','ABO','BO','ZA','AB','OB','DOME','DOMED','CAT','AT','ATE','ETA','FETA']),
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
  grabFunction('findBoardDefect'),
  grabFunction('scoreWords'),
  grabFunction('scorePlay'),
  grabFunction('validatePlay'),
  grabFunction('getRemovableInfo'),
  grabFunction('earnsAllTilesBonus'),
  grabFunction('buildReplayFrames'),
  grabFunction('buildSwapPairing'),
  grabFunction('getPlayerId'),
  grabFunction('getDevicePlayerId'),
  grabFunction('myPlayerIds'),
  grabFunction('isMyPlayerId'),
  'var _myLegacyIds = [];',   // var, not let: must be settable as a context property
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

// Game 2XQDRA, 2026-09-02: FETA ran down column 7 and the opponent played across row 4
// off its F, stealing that same F in the same turn. Connectivity was tested against the
// committed board, where the F still stood, so it passed -- and the commit then emptied
// that square, leaving the new word floating in the middle of the board.
check('a word anchored only to a tile stolen this turn is rejected', {
  tiles: [[4,7,'F'], [5,7,'E'], [6,7,'T'], [7,7,'A']],
  placements: {
    '4,8':  { letter: 'A', rackIdx: 0 },
    '4,9':  { letter: 'B', rackIdx: 1 },
  },
  removals: ['4,7'],
}, { allowed: false, errorContains: 'connect' });

// The same play WITHOUT stealing the anchor is a normal, legal move, so the fix must not
// have simply made every steal-plus-play rejectable.
check('the same word is fine when the anchor stays put', {
  tiles: [[4,7,'A'], [5,7,'B'], [6,7,'O']],
  placements: { '4,8': { letter: 'B', rackIdx: 0 } },
}, { allowed: true });

// A board already broken before this turn stays playable -- games damaged by the old
// tile bug must not be locked out by the new gate.
check('an already-disconnected board does not block a legal play', {
  tiles: [[4,7,'A'], [4,8,'B'], [10,2,'A'], [10,3,'T']],
  placements: { '4,9': { letter: 'O', rackIdx: 0 } },
}, { allowed: true });

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

console.log('\nPlayer identity — accounts, devices, and claimed ids\n');

// Signed in, a player is their account so games follow them between devices. Signed out,
// they are this browser profile. Games created under an earlier device id stay theirs via
// the claimed list — get this wrong and a player's games vanish when they sign in.
function identityCase(name, { user, storedId, legacy }, expect) {
  ctx.auth = { currentUser: user };
  ctx.localStorage = {
    _v: storedId,
    getItem() { return this._v || null; },
    setItem(k, v) { this._v = v; },
  };
  ctx._myLegacyIds = legacy || [];

  const problems = [];
  if (expect.playerId && ctx.getPlayerId() !== expect.playerId)
    problems.push(`identity was "${ctx.getPlayerId()}", expected "${expect.playerId}"`);
  for (const id of expect.mine || [])
    if (!ctx.isMyPlayerId(id)) problems.push(`"${id}" should have been recognised as mine`);
  for (const id of expect.notMine || [])
    if (ctx.isMyPlayerId(id)) problems.push(`"${id}" should NOT have been recognised as mine`);

  if (!problems.length) { passed++; console.log('  pass  ' + name); return; }
  failures.push(name);
  console.log('  FAIL  ' + name);
  problems.forEach(p => console.log('          ' + p));
}

identityCase('signed in, the account is the identity', {
  user: { uid: 'ACCOUNT1', isAnonymous: false }, storedId: 'device-a',
}, { playerId: 'ACCOUNT1' });

// An anonymous uid is minted per origin and per install, so it must never become identity.
identityCase('anonymous players stay on the device id', {
  user: { uid: 'ANON-UID', isAnonymous: true }, storedId: 'device-a',
}, { playerId: 'device-a', notMine: ['ANON-UID'] });

identityCase('signed out entirely, still the device id', {
  user: null, storedId: 'device-a',
}, { playerId: 'device-a' });

// The case the migration exists for: sign in on a second device and games made on the first
// are still yours, because the account claimed that device's id.
identityCase('games from a claimed device are still mine', {
  user: { uid: 'ACCOUNT1', isAnonymous: false }, storedId: 'device-b', legacy: ['device-a'],
}, { playerId: 'ACCOUNT1', mine: ['ACCOUNT1', 'device-a', 'device-b'], notMine: ['device-z', 'ACCOUNT2'] });

// Firestore 'in' queries reject more than 30 values, so the list has to stay bounded.
identityCase('the id list stays within the query limit', {
  user: { uid: 'ACCOUNT1', isAnonymous: false }, storedId: 'device-b',
  legacy: Array.from({ length: 60 }, (_, i) => 'dev' + i),
}, { playerId: 'ACCOUNT1' });
(function () {
  const ids = ctx.myPlayerIds();
  if (ids.length <= 30) { passed++; console.log('  pass  and is capped at 30 ids'); }
  else { failures.push('id cap'); console.log('  FAIL  id list was ' + ids.length + ', over the 30 limit'); }
})();

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

// ── Abandoned-turn round trip ────────────────────────────────────────────────
// Leaving a game mid-turn used to leave pendingPlacements alive in memory. loadAiGameState
// then ran resetPending() AFTER `playerRack = s.playerRack`, so the abandoned turn's
// cancel-restore was applied to the freshly loaded rack: swapped slots were overwritten by
// letters from a turn that rack never played, and stolen slots were spliced out entirely.
// The player saw their tiles silently change on re-entering the game.
(function () {
  vm.runInContext([
    'var playerRack = [];',
    'var pendingRemovalInfo = {};',
    'var swapMode = false, swapCount = 0;',
    'var swappedRackIndices = new Set();',
    // resetPending also drops the tap-selected board square, which is pure DOM work and
    // has nothing to do with the rack restore under test here.
    'var clearCellSelection = function () {};',
    grabFunction('resetPending'),
  ].join('\n'), ctx);

  // The cancel path itself: a swap put the board's L into slot 2, holding G to give back.
  ctx.playerRack = ['A', 'B', 'L', 'D'];
  ctx.pendingPlacements = { '7,7': { letter: 'G', rackIdx: 2, isSwap: true } };
  ctx.resetPending();
  if (ctx.playerRack.join('') === 'ABGD') {
    passed++; console.log('  pass  cancelling a swap gives the rack tile back');
  } else {
    failures.push('cancelling a swap gives the rack tile back');
    console.log('  FAIL  cancelling a swap gives the rack tile back');
    console.log('          expected: ABGD');
    console.log('          actual:   ' + ctx.playerRack.join(''));
  }

  // The ordering that made that restore destructive. Structural on purpose: the bug was
  // two correct statements in the wrong order, which no amount of calling them can catch.
  // Strip line comments first — the code carries a comment naming resetPending(), and
  // matching that instead of the call makes this test pass on the very order it guards.
  const load = grabFunction('loadAiGameState').replace(/^\s*\/\/.*$/gm, '');
  const reset = load.indexOf('resetPending()');
  const assign = load.indexOf('playerRack = s.playerRack');
  if (reset !== -1 && assign !== -1 && reset < assign) {
    passed++; console.log('  pass  loadAiGameState clears pending before loading the rack');
  } else {
    failures.push('loadAiGameState clears pending before loading the rack');
    console.log('  FAIL  loadAiGameState clears pending before loading the rack');
    console.log('          resetPending() must run BEFORE playerRack is replaced');
  }

  if (grabFunction('showHomeScreen').includes('resetPending()')) {
    passed++; console.log('  pass  leaving for the home screen cancels a half-built turn');
  } else {
    failures.push('leaving for the home screen cancels a half-built turn');
    console.log('  FAIL  leaving for the home screen cancels a half-built turn');
  }
})();

// ── Putting a stolen tile back ───────────────────────────────────────────────
// Undoing one steal used to mean the global Recall button, which throws away the whole
// turn. These cover the targeted undo the drag/tap gestures now reach.
console.log('\nPutting a stolen tile back — one steal, not the whole turn\n');

(function () {
  vm.runInContext([
    'var playerRack = [];',
    'var pendingRemovalInfo = {}, pendingRemovals = new Set();',
    'var swappedRackIndices = new Set(), swapCount = 0;',
    'var window = {};',
    'var playRecall = function () {}, computeBestScore = function () {};',
    'var updateUI = function () {}, showMsg = function () {};',
    grabFunction('isStealOrigin'),
    grabFunction('recallRemoval'),
  ].join('\n'), ctx);

  const ok = (name, cond, expected, actual) => {
    if (cond) { passed++; console.log('  pass  ' + name); return; }
    failures.push(name);
    console.log('  FAIL  ' + name);
    console.log('          expected: ' + expected);
    console.log('          actual:   ' + actual);
  };

  // A steal pushes the stolen letter onto the end of the rack and marks the square.
  function stealSetup() {
    ctx.playerRack = ['W', 'X', 'Y', 'F'];      // F stolen off 7,7 into slot 3
    ctx.swappedRackIndices = new Set([3]);
    ctx.pendingRemovals = new Set(['7,7']);
    ctx.pendingRemovalInfo = { '7,7': { letter: 'F', rackIdx: 3, isBlank: false } };
    ctx.swapCount = 1;
    ctx.pendingPlacements = {};
  }

  // Identified by rack slot, never by letter — the W in slot 0 is not the stolen tile even
  // if the player is holding another F.
  stealSetup();
  ok('the stolen slot is recognised as that square\'s origin',
    ctx.isStealOrigin('7,7', 3) === true, 'true', String(ctx.isStealOrigin('7,7', 3)));
  ok('a different rack slot is not',
    ctx.isStealOrigin('7,7', 0) === false, 'false', String(ctx.isStealOrigin('7,7', 0)));
  ok('an untouched square has no steal to undo',
    ctx.isStealOrigin('9,9', 3) === false, 'false', String(ctx.isStealOrigin('9,9', 3)));

  // The whole point: other placements this turn must survive the undo.
  stealSetup();
  ctx.pendingPlacements = {
    '5,5': { letter: 'W', rackIdx: 0 },   // a normal play the user wants to keep
    '5,6': { letter: 'F', rackIdx: 3 },   // the stolen tile, played out
  };
  ctx.recallRemoval('7,7');

  ok('the stolen tile leaves the rack again',
    ctx.playerRack.join('') === 'WXY', 'WXY', ctx.playerRack.join(''));
  ok('its own placement is dropped',
    ctx.pendingPlacements['5,6'] === undefined, 'gone', JSON.stringify(ctx.pendingPlacements['5,6']));
  ok('the rest of the turn is left standing',
    JSON.stringify(ctx.pendingPlacements['5,5']) === JSON.stringify({ letter: 'W', rackIdx: 0 }),
    '{"letter":"W","rackIdx":0}', JSON.stringify(ctx.pendingPlacements['5,5']));
  ok('the square stops being marked for removal',
    !ctx.pendingRemovals.has('7,7') && ctx.pendingRemovalInfo['7,7'] === undefined,
    'unmarked', JSON.stringify([...ctx.pendingRemovals]));
  ok('the swap allowance is handed back',
    ctx.swapCount === 0, '0', String(ctx.swapCount));
  ok('the slot is no longer flagged as holding a stolen tile',
    ctx.swappedRackIndices.size === 0, 'empty', JSON.stringify([...ctx.swappedRackIndices]));

  // Placements above the spliced slot must follow the rack down, or they point at the wrong
  // tile at commit -- the fault that minted a Z and destroyed an F in game 2XQDRA.
  stealSetup();
  ctx.playerRack = ['W', 'F', 'X', 'Y'];
  ctx.swappedRackIndices = new Set([1]);
  ctx.pendingRemovalInfo = { '7,7': { letter: 'F', rackIdx: 1, isBlank: false } };
  ctx.pendingPlacements = { '5,5': { letter: 'Y', rackIdx: 3 } };
  ctx.recallRemoval('7,7');
  ok('a placement above the freed slot follows the rack down',
    ctx.pendingPlacements['5,5'].rackIdx === 2 && ctx.playerRack[2] === 'Y',
    'rackIdx 2 -> Y', 'rackIdx ' + ctx.pendingPlacements['5,5'].rackIdx + ' -> ' + ctx.playerRack[2]);
})();

// ── Strength meter — an estimate the board disproves ─────────────────────────
// The meter divides the play by a "best possible" that, past FULL_DICT_TILE_LIMIT tiles,
// comes from the 3,545-word curated list rather than the 191,852-word dictionary. That
// estimate can land BELOW the play the player has already made, and Math.min(1, ...) turned
// that contradiction into a confident 100% — the false full bar reported since Build 40.
console.log('\nStrength meter — refusing to report a disproved estimate\n');

(function () {
  // scorePlay is stubbed so the play's value is fixed: the decision is what is under test,
  // not the scoring, which its own section already covers.
  vm.runInContext([
    'var bestPossibleScore = null, _bestScoreTimer = null, playerRack = [];',
    'var pendingRemovalInfo = {}, swapPendingPositions = new Set();',
    'var _stubPlayScore = 0;',
    'var scorePlay = function () { return _stubPlayScore; };',
    'var validatePlay = function () { return { ok: true, words: [] }; };',
    'var earnsAllTilesBonus = function () { return false; };',
    'var computeBestScore = function () {};',
    'var _fill = { style: {} }, _pct = { textContent: null };',
    'var document = { getElementById: function (id) {',
    '  return id === "strength-fill" ? _fill : id === "strength-pct" ? _pct : null; } };',
    grabFunction('updateStrengthBar'),
  ].join('\n'), ctx);

  const ok = (name, cond, expected, actual) => {
    if (cond) { passed++; console.log('  pass  ' + name); return; }
    failures.push(name);
    console.log('  FAIL  ' + name);
    console.log('          expected: ' + expected);
    console.log('          actual:   ' + actual);
  };

  const render = (playScore, best) => {
    ctx.pendingPlacements = { '7,7': { letter: 'A', rackIdx: 0 } };
    ctx._stubPlayScore = playScore;
    ctx.bestPossibleScore = best;
    ctx.updateStrengthBar();
    return { pct: ctx._pct.textContent, width: ctx._fill.style.width };
  };

  // The reported case: a 24-point play against a curated "best" of 24 or less.
  let r = render(24, 24);
  ok('a play equal to the estimate still reports',
    r.pct === '100%', '100%', String(r.pct));

  r = render(24, 18);
  ok('an estimate below the play reports nothing rather than 100%',
    r.pct === '' && r.width === '0%', "'' and 0%", JSON.stringify(r));

  // A trustworthy estimate must still read normally.
  r = render(30, 60);
  ok('a sound estimate reports its real ratio',
    r.pct === '50%' && r.width === '50%', '50%', JSON.stringify(r));

  r = render(46, 46);
  ok('a genuinely optimal play still reads 100%',
    r.pct === '100%', '100%', String(r.pct));
})();

// ── Narrating the turn that just ended ───────────────────────────────────────
// Game W2ME2H (Brady vs Mohan, 2026-09-13): Mohan exchanged tiles, which ends a turn without
// touching the board or lastPlayScore. The previous play's 36 survived and was read back as
// " Mohan scored 36 pts." -- the asker's own JOLTS, credited to his opponent, while his word
// sat highlighted with a 36 badge. It read as her turn being skipped.
console.log('\nTurn narration — only report a turn to the player whose turn it was\n');

(function () {
  vm.runInContext([grabFunction('describeLastAction')].join('\n'), ctx);

  const ok = (name, actual, expected) => {
    if (actual === expected) { passed++; console.log('  pass  ' + name); return; }
    failures.push(name);
    console.log('  FAIL  ' + name);
    console.log('          expected: ' + JSON.stringify(expected));
    console.log('          actual:   ' + JSON.stringify(actual));
  };

  const play     = { role: 'p1', type: 'play', score: 36 };
  const exchange = { role: 'p2', type: 'exchange', count: 5 };
  const pass     = { role: 'p2', type: 'pass' };

  // The reported bug: p1's own play must not be narrated to p1 as the opponent's.
  ok('my own play is not read back to me as my opponent\'s',
    ctx.describeLastAction(play, 'p2', 'Mohan'), '');
  ok('my own play is reported to me as mine',
    ctx.describeLastAction(play, 'p1', 'You'), ' You scored 36 pts.');

  ok('an exchange is reported, not silently skipped',
    ctx.describeLastAction(exchange, 'p2', 'Mohan'), ' Mohan exchanged 5 tiles.');
  ok('one exchanged tile is singular',
    ctx.describeLastAction({ role: 'p2', type: 'exchange', count: 1 }, 'p2', 'Mohan'),
    ' Mohan exchanged 1 tile.');
  ok('a pass is reported',
    ctx.describeLastAction(pass, 'p2', 'Mohan'), ' Mohan passed.');

  // Games created before lastAction existed carry none. Saying nothing is right: the field
  // that used to be used cannot tell a play from an exchange, which is the whole bug.
  ok('a game with no recorded action says nothing rather than guessing',
    ctx.describeLastAction(undefined, 'p2', 'Mohan'), '');
  ok('a null action says nothing',
    ctx.describeLastAction(null, 'p2', 'Mohan'), '');
})();

// ── The More menu opens only when asked ──────────────────────────────────────
// Reported twice as "the in game menu keeps popping up". Cancelling a confirm sheet used to
// re-open the menu, which is the only way it ever appeared without the player tapping MORE.
// Structural on purpose: the fault is a callback being wired up, which no amount of calling
// these functions can detect.
console.log('\nMore menu — nothing opens it but the MORE button\n');

(function () {
  const ok = (name, cond, detail) => {
    if (cond) { passed++; console.log('  pass  ' + name); return; }
    failures.push(name);
    console.log('  FAIL  ' + name);
    console.log('          ' + detail);
  };

  // Every mention of openMoreMenu, minus its own declaration, must be inside toggleMoreMenu.
  const mentions = (src.match(/openMoreMenu/g) || []).length;
  const declared = (src.match(/function openMoreMenu\s*\(/g) || []).length;
  const inToggle = (grabFunction('toggleMoreMenu').match(/openMoreMenu/g) || []).length;
  ok('openMoreMenu is called only by toggleMoreMenu',
    mentions - declared === inToggle,
    `${mentions} mentions, ${declared} declaration(s), ${inToggle} inside toggleMoreMenu — ` +
    'something else opens the menu');

  // Specifically: never handed to showConfirmSheet as its onCancel.
  ok('no confirm sheet re-opens the menu when cancelled',
    !/showConfirmSheet\([^)]*openMoreMenu/.test(src) && !/openMoreMenu\s*\)/.test(src.replace(/function openMoreMenu\s*\(\s*\)/g, '')),
    'a showConfirmSheet call still passes openMoreMenu as its cancel callback');

  // Leaving the game screen must drop the menu, or it survives into the next screen and
  // no tap will clear it — which is what forced an app restart.
  ok('leaving for the home screen closes the menu',
    grabFunction('showHomeScreen').includes('closeMoreMenu()'),
    'showHomeScreen does not call closeMoreMenu()');
  ok('entering the game screen closes the menu',
    grabFunction('showGameScreen').includes('closeMoreMenu()'),
    'showGameScreen does not call closeMoreMenu()');

  // The open/closed answer must come from the element, not a flag that can drift.
  // Strip line comments: the code carries one naming the old flag, and matching that instead
  // of a real reference would fail on the fixed version.
  const codeOnly = src.replace(/^\s*\/\/.*$/gm, '');
  ok('menu state is read from the DOM, not a shadow flag',
    /classList\.contains\('show'\)/.test(grabFunction('isMoreMenuOpen')) && !/\bmoreMenuOpen\b/.test(codeOnly),
    'isMoreMenuOpen does not read the element, or a moreMenuOpen flag is still around');
})();

// ── Strength meter: "best possible" must count the all-tiles bonus ─────────────────────
// The player's score includes the 35-point bonus; the search did not. A 7-tile play then
// beat "best possible" and the meter blanked (DRILLING, 15 + 35, against Aaron).
console.log('\nStrength meter — best possible includes the all-tiles bonus\n');

(function () {
  const ok = (name, cond, detail) => {
    if (cond) { passed++; console.log('  pass  ' + name); return; }
    failures.push(name);
    console.log('  FAIL  ' + name);
    console.log('          ' + detail);
  };
  const c = { BS: 15, aiSkill: 'hard', WORDS: new Set(['DRILLING']), AI_WORDS: null, console };
  c.AI_WORDS = c.WORDS;
  vm.createContext(c);
  vm.runInContext([
    grabLines('const PREMIUM = {}', "PREMIUM['7,7']"),
    grabLines('const VAL = {', 'const VAL = {'),
    grabFunction('getWordAt'), grabFunction('getWordsFormed'), grabFunction('hasAdjacentTile'),
    grabFunction('scoreWords'), grabFunction('canSpell'), grabFunction('findBestPlayWithRack'),
    'this.run = (bonus) => { const b = Array.from({length: BS}, () => Array(BS).fill(null)); b[7][7] = "I";' +
    ' const r = findBestPlayWithRack(["D","R","L","L","I","N","G"], b, WORDS, new Set(), bonus); return r ? r.score : 0; };',
  ].join('\n'), c);
  const plain = c.run(false), meter = c.run(true);
  ok('meter search adds 35 for a play using all seven tiles', meter === plain + 35 && plain > 0,
    `without bonus ${plain}, with bonus ${meter}`);
  ok('meter search passes withBonus; AI searches do not',
    (src.match(/findBestPlayWithRack\([^;]*new Set\(\), true\);/g) || []).length === 2 &&
    !/findBestPlayWithRack\(newRack[^;]*new Set\(\[`/.test(src),
    'expected exactly the two strength-meter calls to request the bonus');
})();

// ── Strength meter: searched once per turn, not once per tile ──────────────────────────
// Every placement used to start a new search, and each one blanked the bar for a beat.
console.log('\nStrength meter — one search per rack and board\n');

(function () {
  const ok = (name, cond, detail) => {
    if (cond) { passed++; console.log('  pass  ' + name); return; }
    failures.push(name);
    console.log('  FAIL  ' + name);
    console.log('          ' + detail);
  };
  const posts = [], draws = [];
  const c = {
    console, setTimeout: (f) => f(), clearTimeout: () => {},
    board: Array.from({ length: 15 }, () => Array(15).fill(null)),
    playerRack: ['C','A','T','S','E','R','D'],
    pendingRemovals: new Set(), pendingPlacements: {},
    bestPossibleScore: null, _bestScoreTimer: null,
    _strengthWorker: { postMessage: (m) => posts.push(m) }, _strengthWorkerReady: true,
    _strengthReqId: 0, _strengthPending: {},
    initStrengthWorker() {}, isEmpty() { return false; },
    _bestScoreOnThread() { return 5; },
    updateStrengthBar() { draws.push(c.bestPossibleScore); },
  };
  c.board[7][7] = 'A';
  vm.createContext(c);
  vm.runInContext([
    grabLines('const _bestScoreCache = new Map()', 'let _bestScoreDictGen'),
    grabFunction('_searchBoard'), grabFunction('_bestScoreKey'), grabFunction('resetBestScore'),
    grabFunction('computeBestScore'),
    'this.answer = (best) => { const id = Object.keys(_strengthPending).pop(); _strengthPending[id](best); };',
    'this.flushDict = () => { _bestScoreCache.clear(); _bestScoreInFlight = null; _bestScoreDictGen++; };',
  ].join('\n'), c);

  c.computeBestScore();
  c.computeBestScore(); c.computeBestScore();               // placements while it searches
  ok('placing tiles during a search does not start another', posts.length === 1, `${posts.length} searches`);
  c.answer(40);
  c.computeBestScore(); c.computeBestScore();
  ok('placing tiles after the answer reuses it', posts.length === 1 && c.bestPossibleScore === 40,
    `${posts.length} searches, best ${c.bestPossibleScore}`);
  // Starting a search must never empty a bar that already has a reading — that is what kept
  // it vanishing mid-turn. With nothing to show yet the cheap estimate stands in, so there
  // is always something from the first tile onward.
  ok('a search never blanks the bar', !draws.includes(null), `drew ${JSON.stringify(draws)}`);
  ok('the cheap estimate stands in until the real answer lands',
    draws[0] === 5 && c.bestPossibleScore === 40, `drew ${JSON.stringify(draws)}`);

  c.playerRack = ['C','A','T','S','E','R','Q'];               // a steal changes the letters
  c.computeBestScore();
  ok('a steal that changes the letters searches again', posts.length === 2, `${posts.length} searches`);
  c.answer(55);
  c.playerRack = ['D','R','E','S','T','A','C'];               // recalled, in a different order
  c.computeBestScore();
  ok('recalling the steal reuses the first answer', posts.length === 2 && c.bestPossibleScore === 40,
    `${posts.length} searches, best ${c.bestPossibleScore}`);

  c.board[7][8] = 'T';                                         // opponent played
  c.computeBestScore();
  ok('a changed board searches again', posts.length === 3, `${posts.length} searches`);

  c.flushDict();                                               // full dictionary landed mid-search
  c.answer(12);
  ok('an answer from the partial dictionary is discarded and re-searched',
    posts.length === 4 && c.bestPossibleScore !== 12, `${posts.length} searches, best ${c.bestPossibleScore}`);

  // Steals and swaps already made this turn: search the board as it will be committed.
  c.answer(30);
  c.board[3][3] = 'Z'; c.board[4][4] = 'Q';
  c.pendingRemovals = new Set(['3,3']);                                   // Z stolen
  c.pendingPlacements = { '4,4': { letter: 'K', rackIdx: 0, isSwap: true },   // K swapped onto Q
                          '8,8': { letter: 'S', rackIdx: 1 } };              // an ordinary placement
  c.playerRack = ['Q','A','T','S','E','R','D','Z'];
  const before = posts.length;
  c.computeBestScore();
  const sent = posts[posts.length - 1].board;
  ok('a steal or swap starts a search with the new letters', posts.length === before + 1,
    `${posts.length - before} new searches`);
  ok('the searched board has the stolen square empty', sent[3][3] === null, `got ${sent[3][3]}`);
  ok('the searched board shows the swapped-in tile', sent[4][4] === 'K', `got ${sent[4][4]}`);
  ok('ordinary placements stay off the searched board', sent[8][8] === null, `got ${sent[8][8]}`);
})();

if (failures.length) {
  console.error(`\nLogic tests failed (${failures.length} of ${passed + failures.length}). Build stopped.\n`);
  process.exit(1);
}
console.log(`\nLogic tests passed (${passed}).\n`);
