const webpush = require('web-push');
const jwt      = require('jsonwebtoken');
const http2    = require('http2');

// APNs config — set these in Vercel environment variables
const APNS_KEY_ID  = process.env.APNS_KEY_ID  || 'TXTHH3A9JT';
const APNS_TEAM_ID = process.env.APNS_TEAM_ID || 'MGN5YYLFR6';
const APNS_BUNDLE  = process.env.APNS_BUNDLE  || 'com.roundedcornerinc.reword';
const APNS_KEY_PEM = process.env.APNS_KEY_PEM; // full PEM content as env var

// ── Server-side push-token lookup ──────────────────────────────────────────────
// Push tokens used to travel in the request because the sender read them out of the
// recipient's user document — which every signed-in player can read. Looking them up here
// with admin credentials lets those tokens live in a collection no client can read.
//
// Initialised lazily: without FIREBASE_SERVICE_ACCOUNT set, lookups are skipped and the
// endpoint falls back to whatever token the client supplied, exactly as before.
let _adminDb = null;
function adminDb() {
  if (_adminDb) return _adminDb;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return null;
  // firebase-admin v13+ dropped the namespaced API — there is no admin.credential.cert or
  // admin.firestore() any more, and reaching for them throws inside the try/catch below,
  // which looks exactly like "this player has no token".
  const { initializeApp, cert, getApps } = require('firebase-admin/app');
  const { getFirestore } = require('firebase-admin/firestore');
  if (!getApps().length) initializeApp({ credential: cert(JSON.parse(raw)) });
  _adminDb = getFirestore();
  return _adminDb;
}

// Returns { apnsToken, subscription } for a player, from whichever store has it. Reads the
// new pushTokens collection first and falls back to the legacy copy on the user document,
// so this works before and after clients migrate.
async function lookupPushTarget(playerId) {
  const db = adminDb();
  if (!db) return {};
  const [tokenSnap, userSnap] = await Promise.all([
    db.collection('pushTokens').doc(playerId).get(),
    db.collection('users').doc(playerId).get(),
  ]);
  const t = tokenSnap.exists ? tokenSnap.data() : {};
  const u = userSnap.exists  ? userSnap.data()  : {};
  return {
    apnsToken:    t.token || u.apnsToken || null,
    subscription: t.subscription || u.pushSub || null,
  };
}

function makeApnsJwt() {
  // Vercel env vars may store literal \n instead of real newlines — normalize them
  const pem = APNS_KEY_PEM.replace(/\\n/g, '\n');
  return jwt.sign({}, pem, {
    algorithm: 'ES256',
    keyid:     APNS_KEY_ID,
    issuer:    APNS_TEAM_ID,
    expiresIn: '1h'
  });
}

function sendApns(deviceToken, title, body, gameId, recipientRole) {
  return new Promise((resolve, reject) => {
    const token   = makeApnsJwt();
    const payload = JSON.stringify({
      aps: { alert: { title, body }, badge: 1, sound: 'default' },
      gameId,
      recipientRole
    });
    // APNs ONLY speaks HTTP/2 — Node's https module (HTTP/1.1) cannot talk to
    // it and fails with "Parse Error: Expected HTTP/, RTSP/ or ICE/".
    const client = http2.connect('https://api.push.apple.com');
    client.on('error', reject);

    const req = client.request({
      ':method':        'POST',
      ':path':          `/3/device/${deviceToken}`,
      'authorization':  `bearer ${token}`,
      'apns-topic':     APNS_BUNDLE,
      'apns-push-type': 'alert',
      'apns-priority':  '10',
      'content-type':   'application/json'
    });

    let status = 0;
    let data   = '';
    req.on('response', (headers) => { status = headers[':status']; });
    req.setEncoding('utf8');
    req.on('data',  (chunk) => { data += chunk; });
    req.on('end',   () => {
      client.close();
      if (status === 200) resolve();
      else reject(new Error(`APNs ${status}: ${data}`));
    });
    req.on('error', reject);

    req.write(payload);
    req.end();
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  // Vercel auto-parses JSON and URL-encoded bodies, but normalise just in case
  let body = req.body || {};
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch {
      body = Object.fromEntries(new URLSearchParams(body));
    }
  }
  const { subscription, recipientId, title, message, gameId, recipientRole } = body;
  let { apnsToken } = body;

  // Preferred path: the client names who to notify and the token is looked up here, so push
  // tokens never have to sit in a document that other players can read. Clients on older
  // builds still send apnsToken directly — that fallback stays until those builds age out.
  let sub = subscription;
  if (recipientId) {
    try {
      const stored = await lookupPushTarget(recipientId);
      if (stored.apnsToken) apnsToken = stored.apnsToken;
      if (stored.subscription && !sub) sub = stored.subscription;
    } catch (err) {
      console.error('[notify] token lookup failed:', err.message);
    }
  }

  console.log('[notify] method:', req.method, 'recipientId:', recipientId || 'none',
              'apnsToken:', apnsToken ? apnsToken.slice(0,10)+'…' : 'none', 'sub:', !!sub);

  const pushTitle = title   || 'Your turn in Reword!';
  const pushBody  = message || 'Your opponent has played. Your move!';

  // Native iOS — send via APNs
  if (apnsToken) {
    if (!APNS_KEY_PEM) return res.status(500).send('APNs key not configured');
    try {
      await sendApns(apnsToken, pushTitle, pushBody, gameId, recipientRole);
      return res.status(200).send('OK');
    } catch (err) {
      console.error('APNs send error:', err.message);
      return res.status(500).send('APNs failed: ' + err.message);
    }
  }

  // Web push fallback
  if (!sub?.endpoint) return res.status(400).send('Missing subscription or apnsToken');

  const vapidPublic  = (process.env.VAPID_PUBLIC_KEY  || '').replace(/=/g, '').trim();
  const vapidPrivate = (process.env.VAPID_PRIVATE_KEY || '').replace(/=/g, '').trim();
  if (!vapidPublic || !vapidPrivate) return res.status(500).send('Server misconfigured: missing VAPID keys');

  webpush.setVapidDetails('mailto:info@rewordgame.app', vapidPublic, vapidPrivate);

  const payload = JSON.stringify({
    title: pushTitle,
    body:  pushBody,
    icon:  '/icon-192.png',
    badge: '/icon-192.png',
    gameId,
    recipientRole
  });

  try {
    await webpush.sendNotification(sub, payload);
    return res.status(200).send('OK');
  } catch (err) {
    if (err.statusCode === 410 || err.statusCode === 404) return res.status(410).send('Subscription expired');
    console.error('Push send error:', err.message);
    return res.status(500).send('Push failed');
  }
};
