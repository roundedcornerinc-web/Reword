import webpush from 'web-push';
import jwt from 'jsonwebtoken';
import http2 from 'http2';

webpush.setVapidDetails(
  'mailto:info@rewordgame.app',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// APNs config — set these in Vercel environment variables
const APNS_KEY_ID   = process.env.APNS_KEY_ID   || 'LDGH72AK2K';
const APNS_TEAM_ID  = process.env.APNS_TEAM_ID  || 'MGN5YYLFR6';
const APNS_BUNDLE   = process.env.APNS_BUNDLE   || 'com.roundedcornerinc.reword';
const APNS_KEY_PEM  = process.env.APNS_KEY_PEM;  // full PEM content as env var

function makeApnsJwt() {
  // Vercel env vars may store literal \n instead of real newlines — normalize them
  const pem = APNS_KEY_PEM.replace(/\\n/g, '\n');
  return jwt.sign({}, pem, {
    algorithm: 'ES256',
    keyid: APNS_KEY_ID,
    issuer: APNS_TEAM_ID,
    expiresIn: '1h'
  });
}

function sendApns(deviceToken, title, body, gameId, recipientRole) {
  return new Promise((resolve, reject) => {
    const token = makeApnsJwt();
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
      ':method': 'POST',
      ':path': `/3/device/${deviceToken}`,
      'authorization': `bearer ${token}`,
      'apns-topic': APNS_BUNDLE,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'content-type': 'application/json'
    });

    let status = 0;
    let data = '';
    req.on('response', (headers) => { status = headers[':status']; });
    req.setEncoding('utf8');
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      client.close();
      if (status === 200) resolve();
      else reject(new Error(`APNs ${status}: ${data}`));
    });
    req.on('error', reject);

    req.write(payload);
    req.end();
  });
}

export default async function handler(req, res) {
  // Allow requests from Capacitor iOS app and web
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const { subscription, apnsToken, title, message, gameId, recipientRole } = req.body;

  const pushTitle = title || 'Your turn in Reword!';
  const pushBody  = message || 'Your opponent has played. Your move!';

  // Native iOS — send via APNs
  if (apnsToken) {
    if (!APNS_KEY_PEM) return res.status(500).send('APNs key not configured');
    try {
      await sendApns(apnsToken, pushTitle, pushBody, gameId, recipientRole);
      return res.status(200).send('OK');
    } catch(err) {
      console.error('APNs send error:', err.message);
      return res.status(500).send('APNs failed');
    }
  }

  // Web push fallback
  if (!subscription?.endpoint) return res.status(400).send('Missing subscription');

  const payload = JSON.stringify({
    title: pushTitle,
    body:  pushBody,
    icon:  '/icon-192.png',
    badge: '/icon-192.png',
    gameId,
    recipientRole
  });

  try {
    await webpush.sendNotification(subscription, payload);
    return res.status(200).send('OK');
  } catch(err) {
    if (err.statusCode === 410 || err.statusCode === 404) return res.status(410).send('Subscription expired');
    console.error('Push send error:', err.message);
    return res.status(500).send('Push failed');
  }
}
