// Weekly digest emailer for candlewoodlakeevents.com.
// Reads the current EVENTS_DATA from index.html, fetches subscribers from the data proxy,
// and sends a brand-styled HTML digest of the top upcoming events via Resend.
//
// Env:
//   RESEND_API_KEY   (required) Resend API key.
//   ADMIN_PASSWORD   (required) proxy admin password — used to read subscribers AND as the
//                    HMAC key for unsubscribe tokens (must match the proxy's ADMIN_PASSWORD).
//   API_BASE         (optional) proxy origin; defaults to the deployed Vercel proxy.
//   DIGEST_FROM      (optional) From header; default "Candlewood Lake Events <digest@candlewoodlakeevents.com>".
//   DIGEST_TEST_TO   (optional) if set, sends ONLY to this address (test mode) — subscribers untouched.
//   SITE_URL         (optional) default https://candlewoodlakeevents.com
//   SLACK_WEBHOOK_URL(optional) posts a run summary.
//
// Sends nothing and exits 0 (not an error) when there are no events or no recipients.

import { readFile } from 'node:fs/promises';
import crypto from 'node:crypto';

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const API_BASE = (process.env.API_BASE || 'https://candlewood-data-proxy.vercel.app/api').replace(/\/$/, '');
const FROM = process.env.DIGEST_FROM || 'Candlewood Lake Events <digest@candlewoodlakeevents.com>';
const TEST_TO = (process.env.DIGEST_TEST_TO || '').trim();
const SITE_URL = process.env.SITE_URL || 'https://candlewoodlakeevents.com';
const SLACK = process.env.SLACK_WEBHOOK_URL;

const NAVY = '#0c1d38', GOLD = '#c4973b', CREAM = '#faf6ee', INK = '#1c2a44', MUTE = '#6b7688';

function fail(msg) { console.error('DIGEST ABORT:', msg); process.exit(1); }
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const emailOk = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e || '');
const unsubToken = (email) => crypto.createHmac('sha256', ADMIN_PASSWORD).update(String(email).toLowerCase()).digest('hex').slice(0, 20);

// Tag links that point back to our own site with UTM params so Google Analytics attributes
// the traffic to the email digest. External event links are left untouched — Resend's click
// tracking covers those (we have no analytics on third-party sites anyway).
function withUtm(url) {
  try {
    const u = new URL(url);
    if (/(^|\.)candlewoodlakeevents\.com$/i.test(u.hostname)) {
      u.searchParams.set('utm_source', 'digest');
      u.searchParams.set('utm_medium', 'email');
      u.searchParams.set('utm_campaign', 'weekly');
      return u.toString();
    }
  } catch { /* not a valid URL — leave as-is */ }
  return url;
}

function loadEvents() {
  return readFile('index.html', 'utf8').then((html) => {
    const s = html.indexOf('EVENTS_DATA:START'), e = html.indexOf('EVENTS_DATA:END');
    if (s < 0 || e < 0) fail('EVENTS_DATA markers not found in index.html');
    const block = html.slice(s, e);
    const obj = JSON.parse(block.slice(block.indexOf('{'), block.lastIndexOf('}') + 1));
    // This week + next week, top by score.
    const weeks = Array.isArray(obj.weeks) ? obj.weeks : [];
    const pool = [...(weeks[0]?.events || []), ...(weeks[1]?.events || [])];
    return pool
      .filter((ev) => typeof ev.score === 'number')
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
  });
}

async function loadSubscribers() {
  const r = await fetch(`${API_BASE}/admin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: ADMIN_PASSWORD }),
  });
  if (!r.ok) fail(`could not read subscribers from proxy: HTTP ${r.status}`);
  const data = await r.json();
  const seen = new Set();
  const out = [];
  for (const s of (data.subscribers || [])) {
    const email = (s.email || '').trim().toLowerCase();
    if (!emailOk(email) || s.unsubscribed || seen.has(email)) continue;
    seen.add(email);
    out.push({ email, name: (s.name && s.name !== '(anonymous)') ? s.name : '' });
  }
  return out;
}

function eventRow(ev) {
  const price = ev.priceLabel || (ev.priceType === 'free' ? 'Free' : '');
  const link = withUtm(ev.url || ev.sourceUrl || SITE_URL);
  const meta = [ev.dateLabel, ev.town, price].filter(Boolean).map(esc).join(' &nbsp;·&nbsp; ');
  const desc = ev.desc ? `<div style="color:${MUTE};font-size:13px;line-height:1.5;margin-top:4px">${esc(ev.desc).slice(0, 180)}</div>` : '';
  return `
  <tr><td style="padding:14px 0;border-bottom:1px solid #ece6d8">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="vertical-align:top;padding-right:12px;width:44px">
        <div style="background:${GOLD};color:#fff;font-weight:700;font-size:14px;text-align:center;border-radius:22px;width:40px;height:40px;line-height:40px">${ev.score.toFixed(1)}</div>
      </td>
      <td style="vertical-align:top">
        <a href="${esc(link)}" style="color:${NAVY};font-size:16px;font-weight:700;text-decoration:none">${esc(ev.title)}</a>
        <div style="color:${INK};font-size:13px;margin-top:3px">${meta}</div>
        ${desc}
      </td>
    </tr></table>
  </td></tr>`;
}

function buildHtml(events, recipient) {
  const token = unsubToken(recipient.email);
  const unsubUrl = `${API_BASE}/unsubscribe?email=${encodeURIComponent(recipient.email)}&t=${token}`;
  const hi = recipient.name ? `Hi ${esc(recipient.name)}, here's` : `Here's`;
  const rows = events.map(eventRow).join('');
  return { unsubUrl, html: `<!doctype html><html><body style="margin:0;background:${CREAM};font-family:Georgia,'Times New Roman',serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${CREAM}"><tr><td align="center" style="padding:24px 12px">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-radius:10px;overflow:hidden;border:1px solid #ece6d8">
      <tr><td style="background:${NAVY};padding:26px 28px;text-align:center">
        <div style="color:${GOLD};font-size:12px;letter-spacing:2px;text-transform:uppercase">Candlewood Lake Events</div>
        <div style="color:#fff;font-size:24px;font-weight:700;margin-top:6px">This Week Around the Lake</div>
      </td></tr>
      <tr><td style="padding:22px 28px 6px">
        <p style="color:${INK};font-size:15px;line-height:1.6;margin:0 0 8px;font-family:Helvetica,Arial,sans-serif">${hi} the best of what's worth your weekend, live music, festivals, and local happenings within about 25 miles.</p>
      </td></tr>
      <tr><td style="padding:0 28px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-family:Helvetica,Arial,sans-serif">${rows}</table>
      </td></tr>
      <tr><td style="padding:22px 28px">
        <a href="${esc(withUtm(SITE_URL))}" style="display:inline-block;background:${GOLD};color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:11px 22px;border-radius:6px;font-family:Helvetica,Arial,sans-serif">See the full guide →</a>
      </td></tr>
      <tr><td style="background:${CREAM};padding:18px 28px;text-align:center;font-family:Helvetica,Arial,sans-serif">
        <div style="color:${MUTE};font-size:12px;line-height:1.6">You're getting this because you subscribed at candlewoodlakeevents.com.<br>
        <a href="${unsubUrl}" style="color:${MUTE};text-decoration:underline">Unsubscribe</a></div>
      </td></tr>
    </table>
  </td></tr></table></body></html>` };
}

async function sendOne(recipient, events) {
  const { unsubUrl, html } = buildHtml(events, recipient);
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: FROM,
      to: [recipient.email],
      subject: 'This week around Candlewood Lake',
      html,
      headers: { 'List-Unsubscribe': `<${unsubUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
    }),
  });
  if (!r.ok) { const body = await r.text().catch(() => ''); return { ok: false, email: recipient.email, err: `HTTP ${r.status} ${body.slice(0, 200)}` }; }
  return { ok: true, email: recipient.email };
}

async function notifySlack(text) {
  if (!SLACK) return;
  try { await fetch(SLACK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) }); } catch { /* ignore */ }
}

async function main() {
  if (!RESEND_API_KEY) fail('RESEND_API_KEY not set');
  if (!ADMIN_PASSWORD) fail('ADMIN_PASSWORD not set');

  const events = await loadEvents();
  if (!events.length) { console.log('No upcoming events to feature — skipping this week.'); return; }

  let recipients;
  if (TEST_TO) {
    if (!emailOk(TEST_TO)) fail(`DIGEST_TEST_TO is not a valid email: ${TEST_TO}`);
    recipients = [{ email: TEST_TO.toLowerCase(), name: '' }];
    console.log(`TEST MODE — sending only to ${TEST_TO}`);
  } else {
    recipients = await loadSubscribers();
    if (!recipients.length) { console.log('No active subscribers — nothing to send.'); return; }
  }

  console.log(`Sending digest (${events.length} events) to ${recipients.length} recipient(s)…`);
  const results = [];
  for (const rcpt of recipients) {
    results.push(await sendOne(rcpt, events));
    await new Promise((res) => setTimeout(res, 600)); // stay under Resend's rate limit
  }
  const ok = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  console.log(`Sent ${ok}/${results.length}.`);
  failed.forEach((f) => console.error(`  FAILED ${f.email}: ${f.err}`));

  const mode = TEST_TO ? ' (test)' : '';
  await notifySlack(`Weekly digest${mode}: sent ${ok}/${results.length}${failed.length ? `, ${failed.length} failed` : ''}.`);
  if (failed.length && ok === 0) process.exit(1); // total failure is a real error
}

main().catch((e) => fail(e.message));
