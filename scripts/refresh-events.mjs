// Daily events refresh for candlewoodlakeevents.com.
// Run by .github/workflows/daily-events.yml. Fetches the source event calendars,
// asks Claude to extract/score/format them, and rewrites the EVENTS_DATA block in
// index.html (between the EVENTS_DATA:START / EVENTS_DATA:END markers).
//
// Grounded on fetched content to avoid fabrication: Claude is told to only include
// events that appear in the fetched text. If all sources fail or the model returns
// invalid JSON, it aborts WITHOUT writing, so a bad run never publishes.
//
// Env: ANTHROPIC_API_KEY (required), SLACK_WEBHOOK_URL (optional), EVENTS_MODEL (optional).

import { readFile, writeFile } from 'node:fs/promises';

const INDEX = 'index.html';
const START = '/* EVENTS_DATA:START';
const END = '/* EVENTS_DATA:END */';
const MODEL = process.env.EVENTS_MODEL || 'claude-sonnet-5';

const SOURCES = [
  ['New Fairfield', 'https://www.newfairfield.org/community/community-event-calendar'],
  ["Daryl's House", 'https://darylshouseclub.com/shows/'],
  ['Caramoor', 'https://caramoor.org/events/concerts'],
  ['Ridgefield Playhouse', 'https://ridgefieldplayhouse.org/events/'],
  ['Levitt Pavilion', 'https://levittpavilion.com/calendar/'],
  ['Sherman CT', 'https://www.shermanct.gov/municipal-calendar-list---community-events'],
  ['New Milford', 'https://www.newmilfordnow.org/events'],
  ['Litchfield', 'https://visitlitchfieldct.com/events/'],
];

const todayLabel = new Date().toLocaleDateString('en-US', {
  month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York',
});

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function notifySlack(text) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  } catch { /* non-fatal */ }
}

async function fail(msg) {
  console.error('refresh-events: ' + msg);
  await notifySlack(`Daily events refresh FAILED (${todayLabel}): ${msg}`);
  process.exit(1);
}

async function fetchText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'candlewood-events-refresh' } });
    if (!r.ok) return null;
    return stripHtml(await r.text()).slice(0, 8000);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) return fail('ANTHROPIC_API_KEY not set');

  const file = await readFile(INDEX, 'utf8');
  const startIdx = file.indexOf(START);
  const endIdx = file.indexOf(END);
  if (startIdx === -1 || endIdx === -1) return fail('EVENTS_DATA markers not found in index.html');
  const blockStart = file.indexOf('\n', startIdx) + 1; // content begins after the START comment line
  const existingBlock = file.slice(blockStart, endIdx).trim();

  const fetched = [];
  const failedSources = [];
  for (const [name, url] of SOURCES) {
    const text = await fetchText(url);
    if (text) fetched.push(`### ${name} (${url})\n${text}`);
    else failedSources.push(name);
  }
  if (fetched.length === 0) return fail('all source calendars failed to load');

  const prompt = `You maintain a curated local events guide for the Candlewood Lake area (Fairfield & Litchfield Counties, Connecticut). Today is ${todayLabel} (America/New_York).

Below is the CURRENT EVENTS_DATA JavaScript block from the site. Reproduce its EXACT schema and field names.

CURRENT BLOCK:
${existingBlock}

Below is freshly fetched text from the source event calendars. Use ONLY this content as your source of truth. Do NOT invent events, dates, times, or prices. Only include an event if it clearly appears in the fetched content and you can set a real sourceUrl. Accuracy over volume — omit anything uncertain.

SOURCE CONTENT:
${fetched.join('\n\n')}

TASK:
- Produce the updated EVENTS_DATA as a single PURE JSON object (double-quoted keys, no JS, no comments) with the same keys/shape as the current block.
- Cover today through ~6 weeks out. Do NOT include events that have already ended: every event must be today or later, set isPast to false, and leave the past[] array empty ([]). Recompute isTonight and rebuild tonight[] relative to today; every tonight[] entry MUST have a real name, venue, and time (omit any you cannot fill completely). Set "lastUpdated" to "${todayLabel}".
- Score each event: score = Proximity*0.4 + FunQuality*0.6, rounded to one decimal. Proximity by town: Sherman=10, New Fairfield=9.5, New Milford=9.5, Brookfield=8.5, Danbury=8, Ridgefield=8, Kent=7.5, New Preston/Washington=7.5, Caramoor=7.5, Westport/Levitt=6.5. FunQuality is your 0-10 judgment.
- Keep the daryls[] quick-reference list current from the Daryl's House content.
- Output ONLY the JSON object. No commentary, no code fences.`;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    // thinking disabled: this is grounded JSON extraction, no reasoning needed.
    // On claude-sonnet-5 adaptive thinking is ON by default when omitted, which
    // consumes the whole token budget and emits no text (stop_reason=max_tokens).
    body: JSON.stringify({ model: MODEL, max_tokens: 16000, thinking: { type: 'disabled' }, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!resp.ok) return fail(`Anthropic API error ${resp.status}: ${(await resp.text()).slice(0, 300)}`);

  const data = await resp.json();
  let text = (data.content || []).map((c) => c.text || '').join('').trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    console.error('parse failure — stop_reason:', data.stop_reason, '| len:', text.length, '| head:', text.slice(0, 200), '| tail:', text.slice(-200));
    return fail(`model did not return valid JSON (stop_reason=${data.stop_reason}, len=${text.length}): ${e.message}`);
  }
  if (!obj || !Array.isArray(obj.weeks) || typeof obj.lastUpdated !== 'string') {
    return fail('generated JSON missing required shape (weeks[], lastUpdated)');
  }
  for (const k of ['tonight', 'past', 'daryls']) if (!Array.isArray(obj[k])) obj[k] = [];

  const newBlock = `const EVENTS_DATA = ${JSON.stringify(obj, null, 2)};`;
  if (newBlock.trim() === existingBlock) {
    console.log('No changes.');
    await notifySlack(`Daily events refresh (${todayLabel}): no changes.` + (failedSources.length ? ` Sources failed: ${failedSources.join(', ')}.` : ''));
    return;
  }

  const updated = file.slice(0, blockStart) + newBlock + '\n' + file.slice(endIdx);
  await writeFile(INDEX, updated);

  const count = obj.weeks.reduce((a, w) => a + (Array.isArray(w.events) ? w.events.length : 0), 0);
  console.log(`Updated: ${count} events across ${obj.weeks.length} weeks.`);
  await notifySlack(`Daily events refresh (${todayLabel}): ${count} events across ${obj.weeks.length} weeks published.` + (failedSources.length ? ` Sources failed: ${failedSources.join(', ')}.` : ''));
}

main().catch((e) => fail(e.message));
