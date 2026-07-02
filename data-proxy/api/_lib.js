// Shared helpers for the Candlewood Lake Events data proxy.
// Talks to the PRIVATE data repo using a token held server-side (env: GH_TOKEN).
const GH_API = 'https://api.github.com';

function repo() {
  return process.env.DATA_REPO; // e.g. 'vdua-ocrolus/sherman-events-data'
}

function ghHeaders(extra) {
  return Object.assign({
    Authorization: `token ${process.env.GH_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'candlewood-events-data-proxy',
  }, extra || {});
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function parseBody(req) {
  if (!req.body) return {};
  return typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
}

async function readFile(path) {
  const r = await fetch(`${GH_API}/repos/${repo()}/contents/${path}`, { headers: ghHeaders() });
  if (r.status === 404) return { data: [], sha: null };
  if (!r.ok) throw new Error(`read ${path} failed: ${r.status}`);
  const j = await r.json();
  const decoded = Buffer.from(j.content, 'base64').toString('utf8');
  return { data: JSON.parse(decoded), sha: j.sha };
}

// Returns the raw fetch Response so callers can distinguish 409 (conflict).
async function writeFile(path, data, sha) {
  const content = Buffer.from(JSON.stringify(data, null, 2), 'utf8').toString('base64');
  const body = { message: `Update ${path} via data-proxy`, content };
  if (sha) body.sha = sha;
  return fetch(`${GH_API}/repos/${repo()}/contents/${path}`, {
    method: 'PUT',
    headers: ghHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
}

module.exports = { cors, parseBody, readFile, writeFile };
