const webpush = require('web-push');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  const vapidPublic  = process.env.VAPID_PUBLIC_KEY;
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
  if (!vapidPublic || !vapidPrivate) {
    console.error('Missing VAPID env vars');
    return res.status(500).send('Server misconfigured: missing VAPID keys');
  }

  webpush.setVapidDetails('mailto:noreply@reword.app', vapidPublic, vapidPrivate);

  const { subscription, title, message, gameId, recipientRole } = req.body;

  if (!subscription?.endpoint) {
    return res.status(400).send('Missing subscription');
  }

  const payload = JSON.stringify({
    title:   title   || 'Your turn in Reword!',
    body:    message || 'Your opponent has played. Your move!',
    icon:    '/icon-192.png',
    badge:   '/icon-192.png',
    gameId,
    recipientRole
  });

  try {
    await webpush.sendNotification(subscription, payload);
    return res.status(200).send('OK');
  } catch (err) {
    if (err.statusCode === 410 || err.statusCode === 404) {
      return res.status(410).send('Subscription expired');
    }
    console.error('Push send error:', err.message);
    return res.status(500).send('Push failed');
  }
};
