import webpush from 'web-push';
import jwt from 'jsonwebtoken';
import https from 'https';

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
  return jwt.sign({}, APNS_KEY_PEM, {
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
    const options = {
      hostname: 'api.push.apple.com',
      port: 443,
      path: `/3/device/${deviceToken}`,
      method: 'POST',
      headers: {
        'authorization': `bearer ${token}`,
        'apns-topic': APNS_BUNDLE,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload)
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        if (res.statusCode === 200) resolve();
        else reject(new Error(`APNs ${res.statusCode}: ${data}`));
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

export default async function handler(req, res) {
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
