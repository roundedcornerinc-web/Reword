#!/usr/bin/env node
//
// Stage C of moving push tokens out of client-readable documents.
//
// Tokens used to be written onto users/{id}.apnsToken and onto games/{id}.players.*.apnsToken
// (and the pushSub equivalents). Both are readable by any signed-in player, so any of them
// could read anyone else's push token and send notifications as this app. Stage B stopped
// new writes; this removes the copies already there, which is what actually ends it.
//
// It migrates before it deletes: any token found is copied into pushTokens/{playerId} first,
// so a player whose token only ever existed on an old document stays reachable.
//
// KNOWN COST: a client on a build older than Stage B finds an opponent's token by reading
// these documents. Once purged, those clients can no longer send notifications — they fail
// silently — until the player updates. Nothing breaks for anyone on a current build, since
// the endpoint resolves tokens server-side.
//
// Usage, from the repo root:
//   node scripts/purge-push-tokens.js            # dry run, changes nothing
//   node scripts/purge-push-tokens.js --apply    # actually writes
//
// Credentials: reads the same service account JSON that Vercel holds. Point
// GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT_FILE at the file, e.g.
//   FIREBASE_SERVICE_ACCOUNT_FILE=~/.private_keys/reword-...json node scripts/purge-push-tokens.js

const fs = require('fs');
const path = require('path');

const APPLY = process.argv.includes('--apply');

const credPath = process.env.FIREBASE_SERVICE_ACCOUNT_FILE
              || process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (!credPath) {
  console.error('Set FIREBASE_SERVICE_ACCOUNT_FILE to the service account JSON path.');
  process.exit(1);
}
const resolved = credPath.replace(/^~/, process.env.HOME);
if (!fs.existsSync(resolved)) {
  console.error('Service account file not found: ' + resolved);
  process.exit(1);
}

// firebase-admin v13+ is modular: there is no admin.credential / admin.firestore().
let initializeApp, cert, getFirestore, FieldValue;
try {
  ({ initializeApp, cert } = require('firebase-admin/app'));
  ({ getFirestore, FieldValue } = require('firebase-admin/firestore'));
} catch {
  console.error('firebase-admin is not installed here. Run: npm install');
  process.exit(1);
}

initializeApp({ credential: cert(JSON.parse(fs.readFileSync(resolved, 'utf8'))) });
const db = getFirestore();
const DELETE = FieldValue.delete();

// Copy a token into pushTokens/{id} unless something is already stored there.
async function preserve(playerId, token, subscription) {
  if (!playerId || (!token && !subscription)) return false;
  const ref = db.collection('pushTokens').doc(playerId);
  const existing = await ref.get();
  if (existing.exists && (existing.data().token || existing.data().subscription)) return false;
  const doc = { updatedAt: FieldValue.serverTimestamp() };
  if (token) { doc.token = token; doc.platform = 'ios'; }
  if (subscription) { doc.subscription = subscription; if (!doc.platform) doc.platform = 'web'; }
  if (APPLY) await ref.set(doc, { merge: true });
  return true;
}

(async () => {
  console.log(APPLY ? '\nAPPLYING CHANGES\n' : '\nDRY RUN — nothing will be written. Re-run with --apply.\n');
  let migrated = 0, usersCleaned = 0, gamesCleaned = 0;

  const users = await db.collection('users').get();
  for (const doc of users.docs) {
    const d = doc.data();
    if (!d.apnsToken && !d.pushSub) continue;
    if (await preserve(doc.id, d.apnsToken, d.pushSub)) migrated++;
    if (APPLY) await doc.ref.update({ apnsToken: DELETE, pushSub: DELETE });
    usersCleaned++;
  }

  const games = await db.collection('games').get();
  for (const doc of games.docs) {
    const players = doc.data().players || {};
    const update = {};
    for (const role of ['p1', 'p2']) {
      const p = players[role];
      if (!p || (!p.apnsToken && !p.pushSub)) continue;
      if (await preserve(p.id, p.apnsToken, p.pushSub)) migrated++;
      update[`players.${role}.apnsToken`] = DELETE;
      update[`players.${role}.pushSub`]   = DELETE;
    }
    if (!Object.keys(update).length) continue;
    if (APPLY) await doc.ref.update(update);
    gamesCleaned++;
  }

  console.log(`users scanned:   ${users.size}   with tokens: ${usersCleaned}`);
  console.log(`games scanned:   ${games.size}   with tokens: ${gamesCleaned}`);
  console.log(`tokens preserved into pushTokens: ${migrated}`);
  console.log(APPLY ? '\nDone.\n' : '\nDry run complete — no changes made.\n');
  process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
