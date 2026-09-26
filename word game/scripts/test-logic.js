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
let asyncChain = Promise.resolve();   // sections that have to wait on the event loop run one after another, so their output stays in order;
const inSequence = fn => { asyncChain = asyncChain.then(fn); };   // the verdict at the bottom waits for the chain

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
    // Likewise ending a Play countdown: UI work with its own tests further down.
    'var stopPlayCountdown = function () {};',
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

// ── The Remaining Letters panel closes when the game does ────────────────────
// Reported as "the menu springs up automatically in other games". The panel lives inside
// #game-screen and nothing closed it on the way out, so it came back up with the next game;
// the `remainingVisible` flag it used to keep then disagreed with the DOM, and Close opened
// it again. Structural, for the same reason the More menu's checks are.
console.log('\nRemaining Letters — does not survive a change of game\n');

(function () {
  const ok = (name, cond, detail) => {
    if (cond) { passed++; console.log('  pass  ' + name); return; }
    failures.push(name);
    console.log('  FAIL  ' + name);
    console.log('          ' + detail);
  };

  ok('leaving for the home screen closes the panel',
    grabFunction('showHomeScreen').includes('closeRemaining()'),
    'showHomeScreen does not call closeRemaining()');
  ok('entering the game screen closes the panel',
    grabFunction('showGameScreen').includes('closeRemaining()'),
    'showGameScreen does not call closeRemaining()');

  const codeOnly = src.replace(/^\s*\/\/.*$/gm, '');
  ok('panel state is read from the DOM, not a shadow flag',
    /classList\.contains\('show'\)/.test(grabFunction('isRemainingOpen')) &&
    !/\bremainingVisible\b/.test(codeOnly),
    'isRemainingOpen does not read the element, or a remainingVisible flag is still around');

  // The menu item must open the panel outright. A toggle there does the wrong thing whenever
  // the panel is already up behind the menu: the tap dismisses it instead.
  ok('the More menu item opens the panel rather than toggling it',
    /openRemaining\(\);closeMoreMenu\(\)/.test(src) && !/toggleRemaining\(\);closeMoreMenu\(\)/.test(src),
    'the Remaining Letters menu item still calls toggleRemaining');

  // Close and the backdrop must close, never toggle.
  ok('Close and the backdrop only ever close the panel',
    !/remaining-modal-close"\s*onclick="toggleRemaining/.test(src) &&
    !/event\.target===this\)toggleRemaining/.test(src),
    'a dismiss control still calls toggleRemaining');
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

// ── Stats: words drawn as tiles ──────────────────────────────────────────────
// The Stats tab lays out the longest word and the highest scoring play in the tile artwork
// (tiles/tile-A.svg …). It used to be a flat gold lookalike in a wrapping row: a 12-letter
// word orphaned its last tile and the score badge onto a second line, and a blank showed the
// point value of the letter it stood in for.
console.log('\nStats — words drawn as tiles\n');

(function () {
  vm.runInContext([grabFunction('escHtml'), grabFunction('statTiles')].join('\n'), ctx);

  const ok = (name, cond, detail) => {
    if (cond) { passed++; console.log('  pass  ' + name); return; }
    failures.push(name);
    console.log('  FAIL  ' + name);
    console.log('          ' + detail);
  };
  const count = (html, re) => (html.match(re) || []).length;
  const srcs = html => [...html.matchAll(/src="([^"]*)"/g)].map(m => m[1]);
  const files = ls => JSON.stringify(ls.map(l => `tiles/tile-${l}.svg`));
  const VAL = vm.runInContext('VAL', ctx);   // a top-level const is not a property of the context

  const quiz = ctx.statTiles('QUIZ', 84);
  ok('one tile per letter, each its own artwork file', JSON.stringify(srcs(quiz)) === files(['Q','U','I','Z']), JSON.stringify(srcs(quiz)));
  ok('the score is a badge after the tiles', quiz.includes('<span class="stat-tile-score-badge">84</span>'), quiz);
  ok('no score, no badge', !ctx.statTiles('QUIZ', 0).includes('stat-tile-score-badge'), 'badge shown for a 0 score');
  ok('the row is labelled for screen readers', quiz.includes('aria-label="QUIZ, 84 points"'), quiz);

  // A lowercase letter is a blank standing in for it: the artwork's blank, worth nothing — as
  // on the board. The blank artwork has no letter, so one is laid over it.
  const blank = ctx.statTiles('QuIZ');
  ok('a blank uses the blank artwork and the others their own',
    JSON.stringify(srcs(blank)) === files(['Q','blank','I','Z']), JSON.stringify(srcs(blank)));
  ok('a blank carries its letter and a 0, not the value of that letter',
    blank.includes('<text class="tl" x="60" y="52.2">U</text><text class="tv" x="111" y="111">0</text>') && VAL.U > 0, blank);
  ok('the other tiles are not blanks', count(blank, /class="stat-tile blank"/g) === 1 && !ctx.statTiles('QUIZ').includes('blank'), 'an ordinary tile was marked blank');

  ok('an empty word, or the dash placeholder, shows a dash and no tiles',
    ['', undefined, '—'].every(w => srcs(ctx.statTiles(w, 0)).length === 0 && ctx.statTiles(w, 0).includes('—')), ctx.statTiles('', 0));
  // The filename is built from the word, so only A-Z may reach it.
  ok('only letters reach a filename',
    srcs(ctx.statTiles('A/../B"><x y', 1)).every(s => /^tiles\/tile-(?:[A-Z]|blank)\.svg$/.test(s)), JSON.stringify(srcs(ctx.statTiles('A/../B"><x y', 1))));
  // Look for what is left once every tag the builder itself emits is removed: any raw < or >
  // is the word's own, i.e. unescaped.
  const leftover = html => html.replace(/<\/?(?:div|img|svg|text|span)\b[^>]*>/g, '');
  ok('a word can not inject markup',
    !/[<>]/.test(leftover(ctx.statTiles('<b>', 1))) && !/[<>]/.test(leftover(ctx.statTiles('"><i x', 1))), ctx.statTiles('<b>', 1));

  // Structural: the geometry is CSS, which no call here can exercise. What must hold is that
  // the row never wraps and the tiles can give up width to share it, or a long word orphans
  // its last tile again.
  const rule = sel => (new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}').exec(src) || [, ''])[1];
  ok('the tile row never wraps', !/flex-wrap:\s*wrap/.test(rule('.stat-tiles-row')), '.stat-tiles-row wraps again');
  ok('tiles shrink to share the row', /flex:\s*0\s+1\s/.test(rule('.stat-tile')), '.stat-tile no longer has flex-shrink');

  // The tiles are files, so the guards are about the files: they must exist, agree with the
  // game's letter values (the point value is baked into each one), and ship with the build.
  // Sync copies a hard-coded list, and a file missing from it works on the web and breaks in
  // the app — exactly how the splash screen went missing.
  const dir = path.join(__dirname, '..', 'tiles');
  const read = n => { try { return fs.readFileSync(path.join(dir, `tile-${n}.svg`), 'utf8'); } catch (e) { return ''; } };
  const A_Z = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];
  const missing = ['blank', ...A_Z].filter(n => !read(n));
  ok('every letter has its artwork, and so does the blank', missing.length === 0, 'missing from tiles/: ' + missing.join(', '));
  const wrongLetter = A_Z.filter(l => !new RegExp('>' + l + '</text>').test(read(l)));
  ok('each tile shows the letter its filename says', wrongLetter.length === 0, 'wrong letter in: ' + wrongLetter.join(', '));
  const wrongValue = A_Z.filter(l => { const m = /text-anchor="end"[^>]*>(\d+)<\/text>/.exec(read(l)); return !m || Number(m[1]) !== VAL[l]; });
  ok('each tile\'s baked-in point value matches what the game scores',
    wrongValue.length === 0, 'tiles showing a value VAL no longer has (regenerate the artwork): ' + wrongValue.join(', '));
  const pkg = fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8');
  ok('the build ships the tiles: sync copies tiles/ into www/',
    /"sync":[^\n]*cp -r [^&\n]*\btiles\b[^&\n]* www\//.test(pkg), 'package.json "sync" does not copy tiles/ — the app would ship without them');
})();

// ── Scoreboard names: fitted in fractions, and re-fitted when the room changes ───
// Reported as an opponent's "LOVE MONKEY" being cut off. Four separate causes: (1) the fit
// compared whole-pixel scrollWidth to clientWidth, so 75.09px of text in a 75px box counted as
// "fits" and still got an ellipsis; (2) it only ran on a text change or a window resize, so
// the turn arrow appearing (which takes 14px from the name) or the screen being shown left it
// stale; (3) the player's label was observed through its <span>, which renaming replaces;
// (4) there was simply not enough room: iOS WebKit sets "LOVE MONKEY" at 11px about 10% wider
// than Chromium does (82.5px against 75.1px), in a 63px slot on the smallest supported phone.
// (1)-(3) are wiring that no call here can detect, hence structural; (4) is arithmetic.
console.log('\nScoreboard names — fitted in fractions, re-fitted when the room changes\n');

(function () {
  const ok = (name, cond, detail) => {
    if (cond) { passed++; console.log('  pass  ' + name); return; }
    failures.push(name);
    console.log('  FAIL  ' + name);
    console.log('          ' + detail);
  };
  const codeOnly = s => s.replace(/^\s*\/\/.*$/gm, '');

  const fit = codeOnly(grabFunction('_fitOneName'));
  ok('the fit measures text width in fractions, not whole-pixel scrollWidth',
    /_textWidth\(/.test(fit) && !/scrollWidth|clientWidth\s*[<>]/.test(fit),
    '_fitOneName compares whole pixels again — a 75.09px name in a 75px box will clip');

  ok('the columns are observed, so the arrow and screen visibility re-fit',
    /new ResizeObserver\(\s*fitNameLabels\s*\)/.test(src) && /score-left/.test(src) && /score-right/.test(src),
    'nothing re-fits the names when the turn arrow appears or the game screen is shown');

  ok('the player label is watched through its container, not the span a rename replaces',
    /\[\s*'ai-name-display'\s*,\s*'player-name-display'\s*\]/.test(src),
    'the MutationObserver is on #player-name-text, which startEditName() throws away');

  // The pad has to be resettable: an inline width can't be put back with style.width = ''.
  ok('the right-hand pad is CSS and addressable, so the fit can narrow and restore it',
    /<div id="score-right-pad"><\/div>/.test(src) && /#score-right-pad\s*\{[^}]*width:\s*22px/.test(src) &&
    !/<div style="width:22px;flex-shrink:0;"><\/div>/.test(src) && /score-right-pad/.test(codeOnly(grabFunction('fitNameLabels'))),
    'the pad is an inline-styled div again, or fitNameLabels no longer touches it');

  // The arithmetic. planNameRoom says where room comes from for names that are STILL too long
  // at the 11px floor: the pad first (1px for 1px, opponent only), then the logo (2px of logo
  // is 1px for each name), up to LOGO_MAX_SHRINK.
  vm.runInContext([
    grabLines('const LOGO_MAX_SHRINK', 'const LOGO_MAX_SHRINK'),
    grabFunction('clamp'), grabFunction('planNameRoom'),
  ].join('\n'), ctx);
  const CAP = Math.floor(151 * vm.runInContext('LOGO_MAX_SHRINK', ctx));   // read from the code, not restated
  const plan = (opp, me) => ctx.planNameRoom(opp, me, 22, 151);
  const same = (a, b) => a.logoGive === b[0] && a.padGive === b[1];
  const show = p => `logo -${p.logoGive}, pad -${p.padGive}`;

  let p = plan(0, 0);
  ok('names that fit take nothing', same(p, [0, 0]), show(p));
  p = plan(3.9, 0);
  ok('a name a few px short borrows only the pad; the logo is left alone', same(p, [0, 4]), show(p));
  p = plan(20.5, 0);   // the iPhone SE case: 82.5px of "LOVE MONKEY" in a 63px slot, less the cushion
  ok('the SE case is covered by the pad alone, at the full-size logo', same(p, [0, 21]), show(p));
  p = plan(22, 0);
  ok('exactly the pad\'s width still leaves the logo alone', same(p, [0, 22]), show(p));
  p = plan(30, 0);
  ok('past the pad, the logo covers the rest: 16px of logo is 8px per name', same(p, [16, 22]), show(p));
  p = plan(0, 10);
  ok('the player\'s own name can\'t use the pad, so the logo pays for it: 20px is 10px per name', same(p, [20, 0]), show(p));
  p = plan(15, 10);
  ok('the logo\'s gain to both names counts toward the opponent\'s, so the pad gives less', same(p, [20, 5]), show(p));
  p = plan(500, 500);
  ok('the logo never gives up more than its cap, however long the names',
    p.logoGive === CAP && p.padGive === 22, show(p));
  p = ctx.planNameRoom(30, 30, 22, 0);
  ok('with no logo to shrink (image failed to load) the pad still helps', same(p, [0, 22]), show(p));
  p = ctx.planNameRoom(6, 0, 0, 151);
  ok('with no pad the logo covers it', same(p, [12, 0]), show(p));

  // Sweep it: whatever the deficits, the opponent gains at least what it needs unless the levers
  // are exhausted, the levers stay in range, and the logo is touched only when it has to be.
  let bad = null;
  for (let R = 0; R <= 90 && !bad; R += 0.5) for (let L = 0; L <= 50 && !bad; L += 0.5) {
    const q = ctx.planNameRoom(R, L, 22, 151);
    const cap = CAP;
    const oppGain = q.logoGive / 2 + q.padGive, meGain = q.logoGive / 2;
    const exhausted = q.logoGive === cap && (q.padGive === 22 || oppGain >= R);
    if (q.logoGive < 0 || q.logoGive > cap || q.padGive < 0 || q.padGive > 22) bad = `out of range at R=${R} L=${L}: ${show(q)}`;
    else if (R > 0 && oppGain < R && !exhausted) bad = `opponent short at R=${R} L=${L}: ${show(q)}`;
    else if (L > 0 && meGain < L && q.logoGive !== cap) bad = `player short at R=${R} L=${L}: ${show(q)}`;
    else if (L === 0 && R <= 22 && q.logoGive !== 0) bad = `logo touched needlessly at R=${R}: ${show(q)}`;
  }
  ok('for any deficits: enough room unless exhausted, levers in range, logo only when needed', !bad, bad);
})();

// A stand-in AudioContext that keeps a list of what got made. It is as strict as the real thing about the
// values that make it throw (a NaN or negative time, an exponential ramp to 0, a start offset past the end of
// the buffer, an empty buffer). Every play function swallows its errors, so a bad number would make a sound
// silently vanish; log.errors is how a test finds out.
function fakeAudioContext() {
  const log = { sources: [], gains: [], filters: [], oscillators: 0, convolvers: 0, errors: [] };
  const bad = (Err, msg) => { log.errors.push(msg); throw new Err(msg); };
  const finite = (label, v) => { if (typeof v !== 'number' || !Number.isFinite(v)) bad(TypeError, `${label}: non-finite value ${v}`); };
  const at = (label, t) => { finite(label + ' time', t); if (t < 0) bad(RangeError, `${label}: negative time ${t}`); };
  const param = (label) => {
    let v = 0;
    return {
      get value() { return v; },
      set value(x) { finite(label, x); v = x; },
      setValueAtTime(x, t) { finite(label, x); at(label, t); },
      linearRampToValueAtTime(x, t) { finite(label, x); at(label, t); },
      exponentialRampToValueAtTime(x, t) { finite(label, x); at(label, t); if (Math.abs(x) < 1.2e-38) bad(RangeError, `${label}: exponential ramp to ${x}`); },
    };
  };
  const timed = (label) => (when) => { if (when !== undefined) at(label, when); };
  const node = () => ({ connect() {}, start: timed('start'), stop: timed('stop') });
  const ctx = {
    currentTime: 0, sampleRate: 44100, destination: {},
    createGain() { const g = { ...node(), gain: param('gain') }; log.gains.push(g); return g; },
    createBufferSource() {
      const s = { ...node(), buffer: null };
      s.start = (when, offset, duration) => {
        if (when !== undefined) at('start', when);
        if (offset !== undefined) { finite('start offset', offset); if (offset < 0 || (s.buffer && s.buffer.duration && offset >= s.buffer.duration)) bad(RangeError, `start offset ${offset} is outside the buffer`); }
        if (duration !== undefined) { finite('start duration', duration); if (duration < 0) bad(RangeError, 'negative duration'); }
      };
      log.sources.push(s); return s;
    },
    createOscillator() { log.oscillators++; return { ...node(), frequency: param('frequency'), detune: param('detune'), type: '' }; },
    createBiquadFilter() { const f = { ...node(), frequency: param('filter frequency'), Q: param('Q'), type: '' }; log.filters.push(f); return f; },
    createConvolver() { log.convolvers++; return { ...node(), buffer: null }; },
    createBuffer(ch, len, rate) {
      if (!(len >= 1)) bad(RangeError, 'an empty buffer');
      if (!(rate >= 3000 && rate <= 768000)) bad(RangeError, `sample rate ${rate}`);
      return { length: len, sampleRate: rate, duration: len / rate, getChannelData: () => new Float32Array(len) };
    },
  };
  return { ctx, log };
}

// ── Recorded sounds: the cues that are files, and the synthesis that backs them up ──────────
// Word played, the opponent's word and Exchange play recordings from sounds/. What can go
// wrong here is quiet: a file missing from the build (sync copies a hard-coded list, so the web
// works and the app plays the old synthesis), a recording wired to the wrong event, a failed
// download leaving a cue silent, or the recording AND the synthesized version playing at once.
inSequence(async function () {
  console.log('\nRecorded sounds — files first, synthesis as the fallback\n');
  const ok = (name, cond, detail) => {
    if (cond) { passed++; console.log('  pass  ' + name); return; }
    failures.push(name);
    console.log('  FAIL  ' + name);
    console.log('          ' + detail);
  };
  const grabAsync = n => 'async ' + grabFunction(n);   // grabFunction slices from the word "function"
  const tick = () => new Promise(r => setImmediate(r)); // lets every pending promise settle
  const root = path.join(__dirname, '..');

  // A fresh page context each time, so one group's loaded files never leak into the next.
  // `fetch` and the offline decoder are stand-ins that record what they were asked for.
  function page() {
    const c = { console, window: {}, asked: [], failing: false, enabled: true, acCalls: 0, made: null };
    c.window.OfflineAudioContext = class { decodeAudioData(data, done) { done({ decodedFrom: data.file }); } };
    c.status = 200;   // what the file answers with: 200, 404, or the native shell's 0
    c.fetch = url => { c.asked.push(url); return c.failing ? Promise.reject(new Error('offline'))
      : Promise.resolve({ ok: c.status >= 200 && c.status < 300, status: c.status, arrayBuffer: () => Promise.resolve({ file: url }) }); };
    c.soundEnabled = () => c.enabled;
    c.getAC = async () => { c.acCalls++; return c.made.ctx; };
    vm.createContext(c);
    vm.runInContext([
      grabLines('const RECORDED = {', '};'),
      grabLines('const _recorded = {}', 'const _recorded = {}'),
      grabFunction('loadRecorded'), grabFunction('playRecorded'), grabFunction('blip'),
      grabAsync('playFanfare'), grabAsync('playWordReveal'), grabAsync('playExchange'),
    ].join('\n'), c);
    return c;
  }
  const RECORDED = vm.runInContext('RECORDED', page());

  // The files: present, real audio, and not so hot that boosting them to match the mix clips.
  function wavInfo(file) {
    let b; try { b = fs.readFileSync(file); } catch (e) { return null; }
    if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') return null;
    let p = 12, fmt = null, data = null;
    while (p + 8 <= b.length) {
      const id = b.toString('ascii', p, p + 4), n = b.readUInt32LE(p + 4);
      if (id === 'fmt ') fmt = { format: b.readUInt16LE(p + 8), ch: b.readUInt16LE(p + 10), rate: b.readUInt32LE(p + 12), bits: b.readUInt16LE(p + 22) };
      if (id === 'data') data = b.subarray(p + 8, p + 8 + n);
      p += 8 + n + (n & 1);
    }
    if (!fmt || !data || fmt.format !== 1 || fmt.bits !== 16) return null;
    let peak = 0;
    for (let i = 0; i + 1 < data.length; i += 2) peak = Math.max(peak, Math.abs(data.readInt16LE(i)) / 32768);
    return { ...fmt, seconds: data.length / 2 / fmt.ch / fmt.rate, peak };
  }
  ok('three cues are recordings: word played, the opponent\'s word, exchange',
    JSON.stringify(Object.keys(RECORDED).sort()) === JSON.stringify(['exchange', 'opponent', 'played']), Object.keys(RECORDED).join());
  for (const [name, r] of Object.entries(RECORDED)) {
    const info = wavInfo(path.join(root, r.file));
    ok(`"${name}" is a real, audible WAV in the build folder (${r.file})`,
      info && info.seconds > 0.3 && info.seconds < 3 && info.peak > 0.05,
      info ? JSON.stringify(info) : `${r.file} is missing, or is not a 16-bit PCM WAV`);
    ok(`"${name}" keeps headroom at its gain (${r.gain}x): peaks under 0.9`,
      info && r.gain > 0 && info.peak * r.gain <= 0.9, info ? `peak ${info.peak.toFixed(3)} x ${r.gain} = ${(info.peak * r.gain).toFixed(3)}` : 'no file');
  }
  const pkg = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
  ok('the build ships the recordings: sync copies sounds/ into www/',
    /"sync":[^\n]*cp -r [^&\n]*\bsounds\b[^&\n]* www\//.test(pkg), 'package.json "sync" does not copy sounds/ — the app would ship without them');

  // Loading: every file is fetched and decoded under its own name, once, and a failure is retried.
  let c = page();
  Object.keys(RECORDED).forEach(n => c.loadRecorded(n));
  Object.keys(RECORDED).forEach(n => c.loadRecorded(n));   // already in flight
  ok('a load already in flight is not started twice', c.asked.length === Object.keys(RECORDED).length, c.asked.join());
  await tick();
  const decoded = n => vm.runInContext(`(_recorded[${JSON.stringify(n)}] || {}).decodedFrom`, c);
  ok('each name is decoded from its own file',
    Object.entries(RECORDED).every(([n, r]) => decoded(n) === r.file), Object.keys(RECORDED).map(n => `${n}: ${decoded(n)}`).join('; '));
  c.loadRecorded('played');
  ok('a recording that has loaded is not fetched again', c.asked.length === Object.keys(RECORDED).length, c.asked.join());

  c = page(); c.failing = true;
  c.loadRecorded('exchange'); await tick();
  ok('a failed download leaves the cue unloaded', decoded('exchange') === undefined, 'decoded anyway');
  c.failing = false; c.loadRecorded('exchange'); await tick();
  ok('and is tried again next time, not given up on', decoded('exchange') === RECORDED.exchange.file, `decoded: ${decoded('exchange')}`);

  // Inside the native app the game's own files answer with status 0 (ok false) and the bytes intact. Reading that as a
  // failure left the recordings unloaded on the phone, playing the old synthesis instead, and nothing else could see it.
  c = page(); c.status = 0; c.loadRecorded('opponent'); await tick();
  ok('a file that answers with status 0, as the native app\'s files do, loads', decoded('opponent') === RECORDED.opponent.file, `decoded: ${decoded('opponent')}`);
  c = page(); c.status = 404; c.loadRecorded('opponent'); await tick();
  ok('a real 404 is still a failure', decoded('opponent') === undefined, 'a 404 loaded');

  c = page(); delete c.window.OfflineAudioContext;
  let threw = null; try { c.loadRecorded('played'); } catch (e) { threw = e; }
  ok('a browser with no offline decoder just stays on synthesis', !threw && c.asked.length === 0, threw ? String(threw) : 'it fetched anyway');

  // Playing: each event plays ITS recording, at its gain, and nothing else over the top of it.
  const events = [
    ['word played', 'playFanfare', [], 'played'],
    ['the opponent\'s word', 'playWordReveal', [4], 'opponent'],
    ['an exchange', 'playExchange', [], 'exchange'],
  ];
  const sentinels = Object.fromEntries(Object.keys(RECORDED).map(n => [n, { sentinel: n }]));
  for (const [label, fn, args, name] of events) {
    c = page(); c.made = fakeAudioContext(); c.sentinels = sentinels;
    vm.runInContext('Object.assign(_recorded, sentinels)', c);
    await c[fn](...args);
    const { sources, gains, oscillators } = c.made.log;
    ok(`${label} plays the "${name}" recording, and only that`,
      sources.length === 1 && sources[0].buffer === sentinels[name] && oscillators === 0,
      `${sources.length} buffer source(s) [${sources.map(s => s.buffer && s.buffer.sentinel)}], ${oscillators} oscillator(s)`);
    ok(`${label} plays it at the "${name}" gain`, gains.length === 1 && gains[0].gain.value === RECORDED[name].gain, gains.map(g => g.gain.value).join());

    // Not loaded (yet): the synthesized cue plays instead, and the load is started for next time.
    c = page(); c.made = fakeAudioContext();
    await c[fn](...args);
    ok(`${label} still makes a sound before the file has loaded, and asks for it`,
      c.made.log.oscillators > 0 && c.asked.includes(RECORDED[name].file), `${c.made.log.oscillators} oscillator(s); asked: ${c.asked.join() || 'nothing'}`);

    // The Settings switch silences the recording like everything else.
    c = page(); c.made = fakeAudioContext(); c.enabled = false; c.sentinels = sentinels;
    vm.runInContext('Object.assign(_recorded, sentinels)', c);
    await c[fn](...args);
    ok(`${label} is silent with Sound effects off`,
      c.acCalls === 0 && c.made.log.sources.length === 0 && c.made.log.oscillators === 0, 'it made a sound');
  }
});

// ── Recall, Shuffle and Game over: the sounds Braden picked ──────────────────────────────────
// The one button is Shuffle until a tile is on the board, then Recall, and neither used to make a sound: the
// recall blip belonged to tapping a single placed tile, and shuffling was silent. Recall (a swish and a tap),
// Shuffle (a deck riffled) and Game over (a brass fanfare, a muted trombone) are synthesized, so a test can't
// judge how they sound. What it can promise is that each is built without an error its play function would
// swallow, that each is silent with Sound effects off, and that no two shuffles are the same take.
inSequence(async function () {
  console.log('\nRecall, Shuffle and Game over — the picked sounds\n');
  const ok = (name, cond, detail) => {
    if (cond) { passed++; console.log('  pass  ' + name); return; }
    failures.push(name);
    console.log('  FAIL  ' + name);
    console.log('          ' + detail);
  };
  const grabAsync = n => 'async ' + grabFunction(n);

  // Which press makes which sound (the handler only decides; the sounds and actions are stand-ins).
  const calls = [];
  const h = { console, pendingPlacements: {}, swapCount: 0,
    playRecall: () => calls.push('recall sound'), recallTiles: () => calls.push('recall'),
    playShuffle: () => calls.push('shuffle sound'), shuffleRack: () => calls.push('shuffle') };
  vm.createContext(h);
  vm.runInContext(grabFunction('handleShuffleOrRecall'), h);
  const press = (placements, swaps) => { calls.length = 0; h.pendingPlacements = placements; h.swapCount = swaps; h.handleShuffleOrRecall(); return calls.join(' + '); };
  let got = press({}, 0);
  ok('with nothing on the board the button shuffles, with the shuffle sound', got === 'shuffle sound + shuffle', got);
  got = press({ '7,7': { isSwap: false, rackIdx: 0 } }, 0);
  ok('with a tile placed it recalls, with the recall sound', got === 'recall sound + recall', got);
  got = press({}, 1);
  ok('with only a stolen tile pending it recalls, with the recall sound', got === 'recall sound + recall', got);

  // The sounds themselves, against a strict stand-in for the audio context.
  const sound = () => {
    const c = { console, soundEnabled: () => c.enabled, enabled: true, acCalls: 0, made: null };
    c.getAC = async () => { c.acCalls++; return c.made.ctx; };
    vm.createContext(c);
    vm.runInContext([
      grabFunction('sfxRng'), grabLines('const _sfxNoise', 'const _sfxNoise'), grabFunction('sfxNoise'), grabFunction('sfxBus'),
      grabLines('const sfxBandNorm', 'const sfxBandNorm'), grabFunction('sfxTick'), grabFunction('sfxThunk'), grabFunction('sfxSwoosh'),
      grabFunction('sfxHiss'), grabFunction('sfxHall'), grabFunction('sfxBrassNote'),
      grabFunction('recallSlide'), grabFunction('shuffleRiffle'), grabFunction('brassWin'), grabFunction('brassLose'),
      grabAsync('playRecall'), grabAsync('playShuffle'), grabAsync('playGameEnd'),
    ].join('\n'), c);
    return c;
  };
  const play = async (fn, ...args) => { const c = sound(); c.made = fakeAudioContext(); await c[fn](...args); return c; };
  const made = c => `${c.made.log.sources.length} noise source(s), ${c.made.log.oscillators} oscillator(s), ${c.made.log.convolvers} room(s)`;
  const clean = c => `${made(c)}; the audio API would have thrown: ${c.made.log.errors.join(' | ') || 'nothing'}`;

  const recall = await play('playRecall'), shuffle = await play('playShuffle'), win = await play('playGameEnd', true), lose = await play('playGameEnd', false);
  ok('Recall is a swish and a tap, built without a swallowed error',
    recall.made.log.errors.length === 0 && recall.made.log.sources.length >= 2 && recall.made.log.oscillators >= 1, clean(recall));
  ok('Shuffle is a riffle of clicks, built without a swallowed error',
    shuffle.made.log.errors.length === 0 && shuffle.made.log.sources.length >= 30 && shuffle.made.log.filters.length === shuffle.made.log.sources.length, clean(shuffle));
  ok('a win is a brass chord and a cymbal wash in a room, built without a swallowed error',
    win.made.log.errors.length === 0 && win.made.log.oscillators >= 18 && win.made.log.sources.length >= 1 && win.made.log.convolvers === 1, clean(win));
  ok('a loss or tie is a muted trombone in a room, built without a swallowed error',
    lose.made.log.errors.length === 0 && lose.made.log.oscillators >= 9 && lose.made.log.convolvers === 1, clean(lose));
  ok('a win and a loss are different sounds', win.made.log.oscillators !== lose.made.log.oscillators || win.made.log.sources.length !== lose.made.log.sources.length, 'both built the same nodes');
  ok('every noise burst starts inside the noise it is cut from',
    [recall, shuffle, win].every(c => c.made.log.sources.every(s => s.buffer && s.buffer.duration === 1)), 'a burst has no noise buffer');
  ok('each sits at a sane volume: its own level knob is between 0 and 1',
    [recall, shuffle, win, lose].every(c => { const v = c.made.log.gains[0].gain.value; return v > 0 && v < 1; }),
    [recall, shuffle, win, lose].map(c => c.made.log.gains[0].gain.value).join(', '));

  for (const [label, fn, args] of [['Recall', 'playRecall', []], ['Shuffle', 'playShuffle', []], ['a win', 'playGameEnd', [true]], ['a loss', 'playGameEnd', [false]]]) {
    const c = sound(); c.made = fakeAudioContext(); c.enabled = false;
    await c[fn](...args);
    ok(`${label} is silent with Sound effects off`, c.acCalls === 0 && c.made.log.sources.length === 0 && c.made.log.oscillators === 0, 'it made a sound');
  }

  // Two presses should not sound the same: the pitch of each click is drawn afresh.
  const pitches = async () => (await play('playShuffle')).made.log.filters.map(f => Math.round(f.frequency.value)).join();
  const a1 = await pitches(), a2 = await pitches();
  ok('two shuffles are two different takes', a1 !== a2, 'both made the same clicks');
});

// ── Play: held for three seconds before it goes through ─────────────────────────────────────
// One of the opponents reported hitting Play by accident, and a play cannot be taken back. Play now turns into
// Undo and counts down from 3; the play is made when the count ends, or the moment the app is left (iOS freezes
// timers in the background, so a play left counting would hang). While it counts, the play must not be able to
// change, and if anything does change it the countdown is dropped rather than submitting something else.
console.log('\nPlay — held for three seconds before it goes through\n');

(function () {
  const ok = (name, cond, detail) => {
    if (cond) { passed++; console.log('  pass  ' + name); return; }
    failures.push(name);
    console.log('  FAIL  ' + name);
    console.log('          ' + detail);
  };

  // A stand-in element that remembers its classes, and what the button says.
  const element = () => {
    const classes = new Set(), el = {
      classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c),
        toggle: (c, on) => { const want = on === undefined ? !classes.has(c) : !!on; if (want) classes.add(c); else classes.delete(c); } },
      attrs: {}, onclick: null, textContent: '', count: { textContent: '' },
      setAttribute(k, v) { el.attrs[k] = v; }, removeAttribute(k) { delete el.attrs[k]; },
      querySelector: sel => (sel === '.undo-count' ? el.count : null),
      writes: 0, set innerHTML(h) { el.writes++; el.textContent = 'Undo'; },
    };
    return el;
  };
  const label = b => (b.classList.contains('counting') ? `${b.textContent} ${b.count.textContent}` : b.textContent);

  const leaveListener = marker => { try { return grabLines(marker, marker); } catch (e) { return ''; } };

  // A page with the game's countdown code in it, a controllable clock, and every collaborator stubbed.
  function world() {
    const w = { clock: 0, calls: [], tick: null, valid: true, btn: element(), screen: element(), handlers: { document: {}, window: {} } };
    w.screen.classList.add('active');
    const c = {
      console, window: { tutorialMode: false, addEventListener: (t, f) => { w.handlers.window[t] = f; } },
      Date: { now: () => w.clock },
      setInterval: fn => { w.tick = fn; return 7; }, clearInterval: () => { w.tick = null; },
      document: { hidden: false, addEventListener: (t, f) => { w.handlers.document[t] = f; },
        getElementById: id => (id === 'btn-play' ? w.btn : id === 'game-screen' ? w.screen : null) },
      pendingPlacements: { '7,7': { letter: 'C', rackIdx: 0 }, '7,8': { letter: 'A', rackIdx: 1 } },
      pendingRemovals: new Set(), swapPendingPositions: new Set(), exchangeSelectedIdxs: new Set(), _nextGameQueue: [],
      gameOver: false, currentPlayer: 'player', exchangeMode: false, isOnlineMode: false,
      confirmExchange() {}, showOtherGamesOverlay() {},
      // A committed online play clears the turn and redraws, then saveOnlineState hands it to the opponent and redraws again.
      submitPlay: dry => {
        w.calls.push(dry ? 'check' : 'submit');
        if (!dry && c.isOnlineMode) { c.pendingPlacements = {}; c.updatePlayButton(); c.currentPlayer = 'ai'; c.updatePlayButton(); }
        return dry ? w.valid : undefined;
      },
    };
    vm.createContext(c);
    vm.runInContext([
      grabLines('const PLAY_COUNTDOWN_MS', 'const PLAY_COUNTDOWN_MS'), grabLines('const PLAY_CANCEL_GUARD_MS', 'const PLAY_CANCEL_GUARD_MS'),
      grabLines('let _playCountdown', 'let _playCountdown'),
      grabFunction('playSignature'), grabFunction('onPlayButton'), grabFunction('playCountdownHolds'), grabFunction('tickPlayCountdown'),
      grabFunction('stopPlayCountdown'), grabFunction('finishPlayCountdown'), grabFunction('updatePlayButton'),
      // The three events that mean "the app was left", each grabbed on its own so a missing one fails its own test.
      leaveListener("document.addEventListener('visibilitychange', () =>"), leaveListener("window.addEventListener('pagehide'"), leaveListener("window.addEventListener('blur'"),
    ].join('\n'), c);
    w.c = c;
    w.press = () => c.onPlayButton();
    w.advance = ms => { for (let done = 0; done < ms; done += 100) { w.clock += Math.min(100, ms - done); if (w.tick) w.tick(); } };
    w.counting = () => vm.runInContext('_playCountdown', c) !== null;
    w.submits = () => w.calls.filter(x => x === 'submit').length;
    return w;
  }
  const WINDOW_MS = vm.runInContext('PLAY_COUNTDOWN_MS', world().c), GUARD_MS = vm.runInContext('PLAY_CANCEL_GUARD_MS', world().c);
  ok('the countdown is three seconds', WINDOW_MS === 3000, String(WINDOW_MS));

  // Tapping Play: check the play (without making it), then count.
  let w = world(); w.press();
  ok('tapping Play checks the play but does not make it', w.calls.join() === 'check', w.calls.join());
  ok('and the button becomes Undo, showing 3', label(w.btn) === 'Undo 3', label(w.btn));
  ok('and the screen is locked', w.screen.classList.contains('play-pending'), 'no play-pending class');

  w = world(); w.valid = false; w.press();
  ok('a play that is not legal does not start a countdown (the reason is already on screen)', !w.counting() && !w.screen.classList.contains('play-pending'), 'it counted anyway');
  ok('and the button is left as Play', label(w.btn) !== 'Undo 3' && !w.btn.classList.contains('counting'), label(w.btn));

  // The count, and when the play goes through.
  w = world(); w.press();
  const seen = []; for (let t = 0; t < 2900; t += 100) { w.advance(100); const n = w.btn.count.textContent; if (seen[seen.length - 1] !== n) seen.push(n); }
  ok('the number falls 3, 2, 1, a second each', seen.join() === '3,2,1', seen.join());
  ok('the button is drawn once, so the draining fill is not restarted every tick', w.btn.writes === 1, `redrawn ${w.btn.writes} times`);
  ok('nothing is submitted before three seconds are up', w.submits() === 0 && w.counting(), `${w.submits()} submit(s) at 2.9 s`);
  w.advance(100);
  ok('the play goes through when they are', w.submits() === 1 && !w.counting(), `${w.submits()} submit(s) at 3.0 s`);
  ok('and the lock is gone and the button is Play again', !w.screen.classList.contains('play-pending') && label(w.btn) === 'Play', label(w.btn));
  w.advance(1000);
  ok('and it is made only once', w.submits() === 1, `${w.submits()} submits`);

  // Undo.
  w = world(); w.press(); w.advance(500); w.press();
  ok('tapping Undo stops the countdown', !w.counting() && !w.screen.classList.contains('play-pending') && label(w.btn) === 'Play', label(w.btn));
  w.advance(5000);
  ok('and the play is never made', w.submits() === 0, `${w.submits()} submits`);
  w.press(); ok('and Play can be tapped again afterwards', w.counting() && label(w.btn) === 'Undo 3', label(w.btn));

  w = world(); w.press(); w.advance(GUARD_MS - 100); w.press();
  ok('a second tap right after the first (a double-tap) does not cancel', w.counting(), 'it cancelled');
  w.advance(WINDOW_MS);
  ok('and the play still goes through once', w.submits() === 1, `${w.submits()} submits`);

  // Leaving the app makes the play at once, once, whichever event arrives first.
  // Each event is fired if the page listens for it; `fire` says whether it did.
  const fire = (x, target, type) => { const f = x.handlers[target][type]; if (f) f(); return !!f; };
  for (const [what, target, type, hide] of [['the page being hidden', 'document', 'visibilitychange', true], ['the window losing focus', 'window', 'blur', false], ['the page being closed', 'window', 'pagehide', false]]) {
    w = world(); w.press(); w.advance(1000); w.c.document.hidden = hide; const heard = fire(w, target, type);
    ok(`${what} makes the play at once`, heard && w.submits() === 1 && !w.counting() && !w.screen.classList.contains('play-pending'), heard ? `${w.submits()} submit(s)` : `nothing listens for ${type}`);
  }
  w = world(); w.press(); w.advance(1000);
  w.c.document.hidden = true; fire(w, 'window', 'blur'); fire(w, 'document', 'visibilitychange'); fire(w, 'window', 'pagehide'); w.advance(4000);
  ok('blur, hidden and pagehide arriving together make it once', w.submits() === 1, `${w.submits()} submits`);
  w = world(); w.press(); w.advance(500); w.c.document.hidden = false; fire(w, 'document', 'visibilitychange');
  ok('the page becoming visible again is not leaving', w.counting() && w.submits() === 0, 'it acted on a return');
  w = world(); w.c.document.hidden = true; fire(w, 'document', 'visibilitychange'); fire(w, 'window', 'blur');
  ok('leaving the app with nothing counting does nothing', w.calls.length === 0, w.calls.join());

  // The play under the countdown must not change; if the game moves on, drop it and submit nothing.
  w = world(); w.press(); w.advance(500); w.c.pendingPlacements = { '7,7': { letter: 'C', rackIdx: 0 } }; w.advance(100);
  ok('a play that is changed while counting is dropped, not submitted', !w.counting() && w.submits() === 0 && label(w.btn) === 'Play', label(w.btn));
  w = world(); w.press(); w.advance(500); w.c.pendingPlacements = {}; fire(w, 'window', 'blur');
  ok('and leaving the app then does not submit it either', w.submits() === 0, `${w.submits()} submits`);
  w = world(); w.press(); w.advance(500); w.c.gameOver = true; w.advance(100);
  ok('a game that ends while counting drops the countdown', !w.counting() && w.submits() === 0, 'it stayed');
  w = world(); w.press(); w.advance(500); w.c.currentPlayer = 'ai'; w.advance(100);
  ok('so does the turn moving to the opponent', !w.counting() && w.submits() === 0, 'it stayed');
  w = world(); w.press(); w.advance(500); w.screen.classList.remove('active'); w.advance(100);
  ok('so does leaving the game screen', !w.counting() && w.submits() === 0, 'it stayed');

  // The tutorial has its own Play buttons; the real one there keeps working as it did.
  w = world(); w.c.window.tutorialMode = true; w.press();
  ok('in the tutorial Play goes straight through', w.calls.join() === 'submit' && !w.counting(), w.calls.join());

  // The button's other jobs are unchanged by the refactor that moved them into updatePlayButton.
  w = world(); w.c.updatePlayButton();
  ok('on your turn with a tile placed the button is a lit Play', label(w.btn) === 'Play' && w.btn.classList.contains('tiles-placed') && w.btn.onclick === w.c.onPlayButton, label(w.btn));
  w = world(); w.c.pendingPlacements = {}; w.c.updatePlayButton();
  ok('with nothing placed it is a dim Play', label(w.btn) === 'Play' && !w.btn.classList.contains('tiles-placed'), label(w.btn));
  w = world(); w.c.exchangeMode = true; w.c.exchangeSelectedIdxs = new Set([1]); w.c.updatePlayButton();
  ok('while exchanging it is Confirm', label(w.btn) === 'Confirm' && w.btn.onclick === w.c.confirmExchange && w.btn.classList.contains('tiles-placed'), label(w.btn));
  w = world(); w.c.isOnlineMode = true; w.c.currentPlayer = 'opponent'; w.c._nextGameQueue = [{}]; w.c.updatePlayButton();
  ok('waiting on an opponent with other games ready it is Other Games', label(w.btn) === 'Other Games' && w.btn.onclick === w.c.showOtherGamesOverlay, label(w.btn));
  w = world(); w.c.isOnlineMode = true; w.c.currentPlayer = 'opponent'; w.c.updatePlayButton();
  ok('waiting on an opponent with nothing else to do it is a dead Play', label(w.btn) === 'Play' && w.btn.onclick === null && !w.btn.classList.contains('tiles-placed'), label(w.btn));

  // And those are the two states a countdown must end in once an online play goes through, exactly as a plain tap
  // used to leave them: nothing of the countdown (the red pill, its label for screen readers) may be left behind.
  const leftOver = b => (b.classList.contains('counting') ? 'still counting ' : '') + ('aria-label' in b.attrs ? 'still has its Undo label' : '');
  w = world(); w.c.isOnlineMode = true; w.c._nextGameQueue = [{}]; w.press(); w.advance(WINDOW_MS);
  ok('an online play that goes through leaves the button as Other Games when other games are waiting',
    w.submits() === 1 && label(w.btn) === 'Other Games' && w.btn.onclick === w.c.showOtherGamesOverlay && w.btn.classList.contains('tiles-placed') && !leftOver(w.btn),
    `${w.submits()} submit(s), button: ${label(w.btn)} ${leftOver(w.btn)}`);
  w = world(); w.c.isOnlineMode = true; w.press(); w.advance(WINDOW_MS);
  ok('and as a dead, dim Play when there is nothing else to play',
    w.submits() === 1 && label(w.btn) === 'Play' && w.btn.onclick === null && !w.btn.classList.contains('tiles-placed') && !leftOver(w.btn),
    `${w.submits()} submit(s), button: ${label(w.btn)} ${leftOver(w.btn)}`);
  w = world(); w.c.isOnlineMode = true; w.c._nextGameQueue = [{}]; w.press(); w.advance(500); fire(w, 'window', 'blur');
  ok('the same when the play went through because the app was left',
    w.submits() === 1 && label(w.btn) === 'Other Games' && w.btn.onclick === w.c.showOtherGamesOverlay && !leftOver(w.btn),
    `${w.submits()} submit(s), button: ${label(w.btn)} ${leftOver(w.btn)}`);
  w = world(); w.c.isOnlineMode = true; w.c._nextGameQueue = [{}]; w.press(); w.advance(500); w.press();
  ok('and an online play that is undone leaves an ordinary Play, since it is still your turn',
    w.submits() === 0 && label(w.btn) === 'Play' && w.btn.onclick === w.c.onPlayButton && !leftOver(w.btn),
    `${w.submits()} submit(s), button: ${label(w.btn)} ${leftOver(w.btn)}`);

  // submitPlay(true) is the real function's dry run: every check, nothing committed.
  const gate = () => {
    const g = { console, msgs: [], valid: true, currentPlayer: 'player', gameOver: false, isOnlineMode: false, onlineGameId: null,
      pendingPlacements: { '7,7': { letter: 'C', rackIdx: 0 } }, swapPendingPositions: new Set(), swappedRackIndices: new Set(),
      showMsg: m => g.msgs.push(m),
      validatePlay: () => (g.valid ? { ok: true, words: [] } : { ok: false, err: '"CQT" is not a valid word.' }),
      scorePlay: () => { throw new Error('reached scoring'); } };
    vm.createContext(g); vm.runInContext(grabFunction('submitPlay'), g); return g;
  };
  let g = gate(), threw = null, r;
  try { r = g.submitPlay(true); } catch (e) { threw = e; }
  ok('a dry run of a legal play says yes and stops before scoring anything', r === true && !threw, threw ? String(threw) : String(r));
  g = gate(); g.valid = false; r = g.submitPlay(true);
  ok('a dry run of an illegal play says no and shows why', !r && g.msgs.join() === '"CQT" is not a valid word.', `${r}; ${g.msgs.join()}`);
  g = gate(); g.pendingPlacements = {}; r = g.submitPlay(true);
  ok('a dry run with nothing placed says no and asks for a tile', !r && g.msgs.join() === 'Place at least one tile.', `${r}; ${g.msgs.join()}`);
  g = gate(); g.gameOver = true; r = g.submitPlay(true);
  ok('a dry run when it is not your move says no', !r, String(r));
  g = gate(); threw = null;
  try { g.submitPlay(); } catch (e) { threw = e; }
  ok('without dryRun the same play carries on past the checks to scoring and committing', threw && /reached scoring/.test(String(threw)), threw ? String(threw) : 'it stopped at the gate');

  // Wiring the tests above cannot see.
  const codeOnly = t => t.replace(/^\s*\/\/.*$/gm, '');
  ok('the Play button starts on the countdown handler, and updateUI keeps it there',
    /<button id="btn-play" onclick="onPlayButton\(\)">/.test(src) && /updatePlayButton\(\);/.test(codeOnly(grabFunction('updateUI'))) && !/onclick = submitPlay/.test(src),
    'a path still wires Play straight to submitPlay');
  ok('clearing the turn ends a countdown (resetPending, and both screen switches)',
    /function resetPending\([^)]*\) \{\s*stopPlayCountdown\(\);/.test(src) && /function showHomeScreen\(\) \{\s*stopPlayCountdown\(\);/.test(src) && /function showGameScreen\(\) \{\s*stopPlayCountdown\(\);/.test(src),
    'a way of leaving the turn leaves the countdown running');
  const rule = sel => (new RegExp(sel.replace(/[.*+?^${}()|[\]\\>]/g, '\\$&') + '\\s*\\{([^}]*)\\}').exec(src) || [, ''])[1];
  ok('while counting, the board, rack and header are locked but the controls bar (with Undo) is not',
    /pointer-events:\s*none/.test(rule('#game-screen.play-pending > *:not(#controls)')) && /pointer-events:\s*none/.test(rule('#game-screen.play-pending #controls-icons')) &&
    !/pointer-events/.test(rule('#btn-play.counting')), 'the lock rule is missing, or it would lock Undo too');
  ok('the drain animation is switched off for reduced motion', /prefers-reduced-motion:\s*reduce\)\s*\{\s*#btn-play\.counting::before\s*\{\s*display:\s*none/.test(src), 'no reduced-motion rule');

  // updateUI runs to its last line. It read a variable the Play-button refactor had moved out from under it, which
  // no syntax check can see and the first game to draw would have thrown on.
  const ui = () => {
    const el = () => { const e = { textContent: '', innerHTML: '', style: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } } }; return e; };
    const u = { console, window: { tutorialMode: false }, document: { getElementById: () => el() }, replayState: { active: false }, gameOver: false, lastMoveKeys: [],
      bag: [1], playerRack: [1], aiRack: [1], playerScore: 0, aiScore: 0, isOnlineMode: false, opponentOnlineName: 'X', currentPlayer: 'player',
      pendingPlacements: { '7,7': { letter: 'C', rackIdx: 0, isSwap: false } }, swapCount: 0, ran: [] };
    for (const f of ['stopReplay', 'checkGameOver', 'updateTurnBadge', 'renderBoard', 'renderRack', 'renderScorePreview', 'updateReplayButton', 'updateStrengthBar',
      'computeBestScore', 'updateResignButton', 'updatePlayButton']) u[f] = () => u.ran.push(f);
    vm.createContext(u); vm.runInContext(grabFunction('updateUI'), u); return u;
  };
  const u = ui(); let uiError = null;
  try { u.updateUI(); } catch (e) { uiError = e; }
  ok('updateUI runs to the end and refreshes the Play button', !uiError && u.ran.includes('updatePlayButton'), uiError ? String(uiError) : u.ran.join());
})();

asyncChain.then(() => {
  if (failures.length) {
    console.error(`\nLogic tests failed (${failures.length} of ${passed + failures.length}). Build stopped.\n`);
    process.exit(1);
  }
  console.log(`\nLogic tests passed (${passed}).\n`);
}, err => { console.error(err); process.exit(1); });
