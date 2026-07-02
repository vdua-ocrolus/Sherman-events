// POST /api/admin  { password }
// Server-side password check (env: ADMIN_PASSWORD). Returns all collections.
const { cors, parseBody, readFile } = require('./_lib');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  try {
    const { password } = parseBody(req);
    if (!process.env.ADMIN_PASSWORD || password !== process.env.ADMIN_PASSWORD) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    const [visits, subscribers, feedback] = await Promise.all([
      readFile('visits.json'),
      readFile('subscribers.json'),
      readFile('feedback.json'),
    ]);
    return res.status(200).json({
      visits: visits.data,
      subscribers: subscribers.data,
      feedback: feedback.data,
    });
  } catch (e) {
    return res.status(500).json({ error: 'server error' });
  }
};
