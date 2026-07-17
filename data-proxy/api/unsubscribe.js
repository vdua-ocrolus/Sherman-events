// GET /api/unsubscribe?email=<email>&t=<token>
// One-click unsubscribe link included in every digest email. Marks the subscriber
// unsubscribed in subscribers.json. The token is HMAC-SHA256(email, ADMIN_PASSWORD) —
// the same value the digest sender computes — so only the real recipient's link works.
const crypto = require('crypto');
const { readFile, writeFile } = require('./_lib');

function token(email) {
  return crypto.createHmac('sha256', process.env.ADMIN_PASSWORD || '').update(String(email).toLowerCase()).digest('hex').slice(0, 20);
}

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title}</title></head>
  <body style="margin:0;background:#faf6ee;font-family:Georgia,serif;color:#0c1d38">
    <div style="max-width:520px;margin:64px auto;background:#fff;border:1px solid #ece6d8;border-radius:10px;padding:36px 32px;text-align:center">
      <div style="color:#c4973b;font-size:12px;letter-spacing:2px;text-transform:uppercase">Candlewood Lake Events</div>
      <h1 style="font-size:22px;margin:14px 0 10px">${title}</h1>
      <p style="color:#4a5568;font-size:15px;line-height:1.6;font-family:Helvetica,Arial,sans-serif">${body}</p>
      <a href="https://candlewoodlakeevents.com" style="display:inline-block;margin-top:16px;color:#c4973b;font-family:Helvetica,Arial,sans-serif">Back to the guide →</a>
    </div>
  </body></html>`;
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (req.method !== 'GET') return res.status(405).send(page('Not allowed', 'Use the unsubscribe link from your email.'));

  const email = String((req.query && req.query.email) || '').trim().toLowerCase();
  const t = String((req.query && req.query.t) || '').trim();
  if (!email || !t) return res.status(400).send(page('Invalid link', 'This unsubscribe link is missing information.'));
  if (!process.env.ADMIN_PASSWORD || t !== token(email)) {
    return res.status(401).send(page('Link not valid', 'This unsubscribe link is invalid or expired. Reply to any digest email and we\'ll remove you.'));
  }

  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      const { data, sha } = await readFile('subscribers.json');
      const list = Array.isArray(data) ? data : [];
      let changed = false;
      for (const s of list) {
        if ((s.email || '').trim().toLowerCase() === email && !s.unsubscribed) {
          s.unsubscribed = true;
          s.unsubscribed_at = new Date().toISOString();
          changed = true;
        }
      }
      // Idempotent: if already unsubscribed or not found, report success without a write.
      if (!changed) return res.status(200).send(page('You\'re unsubscribed', 'You won\'t receive any more weekly digests. Thanks for stopping by.'));
      const w = await writeFile('subscribers.json', list, sha);
      if (w.ok) return res.status(200).send(page('You\'re unsubscribed', 'You won\'t receive any more weekly digests. Thanks for stopping by.'));
      if (w.status !== 409) return res.status(502).send(page('Something went wrong', 'We couldn\'t process that just now. Please try again in a minute.'));
    }
    return res.status(409).send(page('Please retry', 'We hit a conflict saving your request. Please click the link again.'));
  } catch (e) {
    return res.status(500).send(page('Something went wrong', 'We couldn\'t process that just now. Please try again in a minute.'));
  }
};
