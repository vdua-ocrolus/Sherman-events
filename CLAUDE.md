# Candlewood Lake Events

## What This Is
A curated local events guide for the Candlewood Lake area in Connecticut.
- Live at: https://candlewoodlakeevents.com
- Hosted via: GitHub Pages on vdua-ocrolus/Sherman-events
- Custom domain: candlewoodlakeevents.com (CNAME file in repo root)

## Repos
- Site: vdua-ocrolus/Sherman-events (public) — this repo
- Data: vdua-ocrolus/sherman-events-data (private) — intended to store visits.json, subscribers.json, feedback.json
  - NOTE: currently CONFIG.GITHUB_REPO points at the SITE repo, not this data repo. Data separation is not yet wired up.

## Key File
- index.html — the entire site. Single-file HTML/CSS/JS. No build step.
  - CONFIG block: line ~344
  - EVENTS_DATA object: line ~357

## Architecture
- No build step. Pure static HTML — edit index.html and push; GitHub Pages serves it.
- Client-side JS uses the GitHub API (fetch) to write visitor data, signups, feedback.
- Events are hardcoded in the EVENTS_DATA object. To update events: edit that block and push.

## Secrets — read before editing CONFIG
- This is a PUBLIC repo. Anything in index.html (including CONFIG) is world-readable in page source.
- The GitHub token and admin password currently live in the CONFIG block in plaintext. This is an exposure (see CONTEXT.md). Do not add new secrets to index.html.
- A static Pages site cannot read shell environment variables. Any token used by client-side JS is necessarily visible to visitors. The only clean fix is moving writes server-side (e.g. a GitHub Action via repository_dispatch with the token in GitHub Secrets).

## Scoring Formula
Combined = (Proximity x 0.4) + (Fun/Quality x 0.6)
Proximity: Sherman=10, New Fairfield=9.5, New Milford=9, Brookfield/DH=8.5, Ridgefield/Danbury=8, Caramoor/Kent=7.5, Westport/Levitt=6.5

## Score Classes
- score-must: >= 9.0 (gold gradient)
- score-great: 7.0-8.9 (navy)
- score-good: 5.0-6.9 (green)
- score-ok: < 5.0 (gray)

## Design Language
- Navy (#0c1d38), gold (#c4973b), cream (#faf6ee)
- Playfair Display (headings), Inter (body)
- Luxury Connecticut lake house aesthetic, not a bulletin board

## Admin
- Admin panel: gear icon, bottom right of the live site.
- Password is set in CONFIG.ADMIN_PASSWORD in index.html (needs rotating — see CONTEXT.md).

## Deploy Workflow
1. Edit index.html
2. git add index.html && git commit -m "describe change"
3. git push origin main
4. GitHub Pages auto-deploys in ~60 seconds
5. Verify at https://candlewoodlakeevents.com

## Auth note
Pushing from this machine works via the gh CLI credential helper (already authenticated as vdua-ocrolus). No separate site PAT is required for git operations.
