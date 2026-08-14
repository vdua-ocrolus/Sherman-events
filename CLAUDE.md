# Candlewood Lake Events

## What This Is
A curated local events guide for the Candlewood Lake area in Connecticut.
- Live at: https://candlewoodlakeevents.com
- Hosted via: GitHub Pages on vdua-ocrolus/Sherman-events
- Custom domain: candlewoodlakeevents.com (CNAME file in repo root)

## Repos
- Site: vdua-ocrolus/Sherman-events (public) — this repo
- Data: vdua-ocrolus/sherman-events-data (private) — stores visits.json, subscribers.json, feedback.json (written server-side by the proxy).

## Key File
- index.html — the entire site. Single-file HTML/CSS/JS. No build step.
  - CONFIG block near the top of the <script> (API_BASE, ADMIN_PASSWORD, GA_MEASUREMENT_ID).
  - EVENTS_DATA object lives between the `/* EVENTS_DATA:START */` and `/* EVENTS_DATA:END */` markers (regenerated daily — see below).

## Architecture
- No build step. Pure static HTML — edit index.html and push; GitHub Pages serves it.
- Client-side JS sends visitor/subscriber/feedback data to a serverless proxy (see /data-proxy) via CONFIG.API_BASE; the proxy holds the GitHub token server-side. No token in the page.
- Analytics: Google Analytics 4, gated on CONFIG.GA_MEASUREMENT_ID (a public ID; safe in client source).
- Events live in the EVENTS_DATA object, regenerated daily by a GitHub Action (see "Daily events refresh"). Anything between the EVENTS_DATA markers is overwritten by that job — hand-edit with care.

## Secrets
- This is a PUBLIC repo. Anything in index.html (including CONFIG) is world-readable. Do NOT put private tokens or passwords here.
- The old hardcoded GitHub token and admin password have been removed. Data writes/reads go through the serverless proxy (/data-proxy), which holds the token as a server-side env var.
- CONFIG.GA_MEASUREMENT_ID is a Google Analytics ID and is meant to be public — fine to commit.
- CI secrets live in GitHub → Settings → Secrets and variables → Actions (see "Daily events refresh"), never in the repo.

## Scoring Formula
Combined = (Proximity x 0.3) + (Fun/Quality x 0.7)
Proximity: Sherman=10, New Fairfield=9.5, New Milford=9.5, Brookfield=8.5, Danbury=8, Ridgefield=8, Kent=7.5, New Preston/Washington=7.5, Woodbury=7.5, Roxbury=7.5, Caramoor=7.5, Westport/Levitt=6.5

IMPORTANT — scoring invariant. `funQuality` (0-10) is the only field the refresh pipeline
mutates; `score` is derived from the formula exactly once, by `bakeScores()` at the end of
the chain. Never write `e.score` anywhere else, and never add an adjustment that operates on
the composite — that is what let boosts push scores past a town's ceiling and pile 8 events
onto a clamped 10.0. New adjustments (floors, overrides, value tweaks) belong in FunQuality
space. `scoreViolations()` enforces this and aborts the run if a score exceeds its town
ceiling, so only Sherman can ever reach 10.0.

Evidence gate. A FunQuality of 9.0+ is a marquee claim and requires a `band-ratings.json`
entry with real sources and confidence above "low", or a hand-set `BAND_FLOORS` match.
Anything else caps at 8.5 — the model rates unresearched $10 bar bands 9.9 if you let it.
The gate runs LAST, after the floors and the value adjustment, so a boost can't carry an
event over the line; move it and free events start sneaking into the top.

Note the gate is about *quality*, not the composite. A Sherman event can legitimately score
9.1 on an 8.7 quality because proximity is 30% of the formula — that is the hometown weighting
working, not a leak.

## band-ratings.json (researched-act cache)
Evidence store behind the gate: normalized act name -> {funQuality, tier, draw, confidence,
sources, researchedAt}. Self-maintaining — each refresh researches only the acts making an
unevidenced 9.0+ claim (max 20/run, backlog drains over a few days), validates the records,
and merges NEW keys only, so existing/hand-tuned entries always win. The daily workflow
commits this file; if it stops being committed, every run re-researches the same acts.
Research failure is non-fatal: events still publish and the gate caps the unevidenced claims.

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
- Admin auth is server-side (ADMIN_PASSWORD env on the proxy) once the proxy is live. Interim CONFIG.ADMIN_PASSWORD is a placeholder used only when API_BASE is empty.

## Daily events refresh (CI)
- .github/workflows/daily-events.yml runs daily (~10:00 UTC / ~6am ET) and on manual "Run workflow".
- It runs scripts/refresh-events.mjs: fetches the source calendars, asks Claude (Anthropic API) to extract/score/format events grounded ONLY on fetched content, validates the JSON, and rewrites the EVENTS_DATA block between the markers. Commits + pushes only if changed. Aborts without writing on any failure, so a bad run never publishes.
- Required repo secret: ANTHROPIC_API_KEY. Optional: SLACK_WEBHOOK_URL (posts a run summary). Model via EVENTS_MODEL (default claude-sonnet-5).
- To change sources or scoring, edit scripts/refresh-events.mjs.

## Deploy Workflow
1. Edit index.html
2. git add index.html && git commit -m "describe change"
3. git push origin main
4. GitHub Pages auto-deploys in ~60 seconds
5. Verify at https://candlewoodlakeevents.com

## Auth note
Pushing from this machine works via the gh CLI credential helper (already authenticated as vdua-ocrolus). No separate site PAT is required for git operations.
