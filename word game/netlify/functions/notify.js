const webpush = require('web-push');

webpush.setVapidDetails(
  'mailto:noreply@reword.app',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: 'Bad Request' };
  }

  const { subscription, title, message, gameId, recipientRole } = body;

  if (!subscription?.endpoint) {
    return { statusCode: 400, body: 'Missing subscription' };
  }

  const payload = JSON.stringify({
    title: title || 'Your turn in Reword!',
    body: message || 'Your opponent has played. Your move!',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    gameId,
    recipientRole
  });

  try {
    await webpush.sendNotification(subscription, payload);
    return { statusCode: 200, body: 'OK' };
  } catch (err) {
    // 410 Gone / 404 Not Found = subscription is expired or unregistered
    if (err.statusCode === 410 || err.statusCode === 404) {
      return { statusCode: 410, body: 'Subscription expired' };
    }
    console.error('Push send error:', err.message);
    return { statusCode: 500, body: 'Push failed' };
  }
};
