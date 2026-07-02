# Candlewood Lake Events — Data Proxy

Serverless proxy that holds the GitHub token **server-side** so it never ships in the
public site source. The site (candlewoodlakeevents.com, on GitHub Pages) calls these
endpoints; the proxy reads/writes the **private** `sherman-events-data` repo.

## Endpoints
- `POST /api/append` — body `{ "collection": "visits|subscribers|feedback", "entry": {...} }`. Append-only, no auth.
- `POST /api/admin` — body `{ "password": "..." }`. Returns `{ visits, subscribers, feedback }`. Password checked server-side.

## Deploy (Vercel)
Deploy this `data-proxy/` folder as its **own** Vercel project (separate from the Pages
site, so it only serves `/api/*`).

1. Create a **new fine-grained PAT** with `Contents: Read and write` on **only**
   `vdua-ocrolus/sherman-events-data`. (This replaces the revoked, previously-exposed token.)
2. Install the CLI and deploy:
   ```
   npm i -g vercel
   cd data-proxy
   vercel            # first run: link/create a new project
   ```
3. Set environment variables (Vercel dashboard → Project → Settings → Environment Variables,
   or via CLI `vercel env add`):
   - `GH_TOKEN`         = the new fine-grained PAT
   - `DATA_REPO`        = `vdua-ocrolus/sherman-events-data`
   - `ADMIN_PASSWORD`   = your new admin password (replaces `sherman2026`)
   - `ALLOWED_ORIGIN`   = `https://candlewoodlakeevents.com`
4. Deploy to production:
   ```
   vercel --prod
   ```
5. Copy the production URL and set `CONFIG.API_BASE` in `../index.html` to `<that-url>/api`,
   then commit + push the site.

## Notes
- `append` retries on GitHub's 409 optimistic-lock conflict (low-traffic site; adequate).
- Only the three whitelisted collections can be written. No arbitrary path access.
- If you prefer Netlify: move `api/*.js` to `netlify/functions/`, change handler signature
  to `exports.handler = async (event) => ({ statusCode, body })`, and set the same env vars.
