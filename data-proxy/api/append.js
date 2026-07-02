// POST /api/append  { collection: 'visits'|'subscribers'|'feedback', entry: {...} }
// Append-only, whitelisted collections. No client credential required.
const { cors, parseBody, readFile, writeFile } = require('./_lib');

const COLLECTIONS = {
  visits: 'visits.json',
  subscribers: 'subscribers.json',
  feedback: 'feedback.json',
};

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  try {
    const { collection, entry } = parseBody(req);
    const path = COLLECTIONS[collection];
    if (!path) return res.status(400).json({ error: 'unknown collection' });
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return res.status(400).json({ error: 'invalid entry' });
    }

    // Optimistic read-modify-write with retry on concurrent-write conflict (409).
    for (let attempt = 0; attempt < 4; attempt++) {
      const { data, sha } = await readFile(path);
      const next = Array.isArray(data) ? data : [];
      next.push(Object.assign({}, entry, { _srv_ts: new Date().toISOString() }));
      const w = await writeFile(path, next, sha);
      if (w.ok) return res.status(200).json({ ok: true });
      if (w.status !== 409) return res.status(502).json({ error: `write failed: ${w.status}` });
    }
    return res.status(409).json({ error: 'write conflict, please retry' });
  } catch (e) {
    return res.status(500).json({ error: 'server error' });
  }
};
