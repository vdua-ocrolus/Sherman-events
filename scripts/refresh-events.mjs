// Daily events refresh for candlewoodlakeevents.com  (v2 — web-tool research).
// Run by .github/workflows/daily-events.yml. Claude researches CURRENT events with
// the web_search + web_fetch server tools (so it can reach JS-rendered town/library/
// venue calendars that a plain fetch can't), then rewrites the EVENTS_DATA block in
// index.html between the EVENTS_DATA:START / EVENTS_DATA:END markers.
//
// Guardrails: Claude is told to ground every event in a real source and never invent.
// If the API errors or the model returns invalid JSON, it aborts WITHOUT writing, so
// a bad run never publishes.
//
// Env: ANTHROPIC_API_KEY (required), SLACK_WEBHOOK_URL (optional), EVENTS_MODEL (optional).

import { readFile, writeFile } from 'node:fs/promises';
import Anthropic from '@anthropic-ai/sdk';

const INDEX = 'index.html';
const START = '/* EVENTS_DATA:START';
const END = '/* EVENTS_DATA:END */';
const MODEL = process.env.EVENTS_MODEL || 'claude-sonnet-5';

// Priority calendars to fetch/search. (web_fetch can only fetch URLs present in the
// conversation, so listing them here lets the model pull them directly.)
const SOURCES = [
  ['New Fairfield', 'https://www.newfairfield.org/community/community-event-calendar'],
  ["Daryl's House", 'https://darylshouseclub.com/shows/'],
  ['Caramoor', 'https://caramoor.org/events/concerts'],
  ['Ridgefield Playhouse', 'https://ridgefieldplayhouse.org/events/'],
  ['Levitt Pavilion', 'https://levittpavilion.com/calendar/'],
  ['Sherman CT', 'https://www.shermanct.gov/municipal-calendar-list---community-events'],
  ['New Milford', 'https://www.newmilfordnow.org/events'],
  ['Housatonic River Brewing', 'https://www.housatonicriverbrewing.com/livemusic-events'],
  ['Litchfield', 'https://visitlitchfieldct.com/events/'],
  ['Litchfield Magazine', 'https://litchfieldmagazine.com/things-to-do/'],
  ['A.C.T. of Connecticut', 'https://www.actofct.org/season'],
  ['Palace Danbury', 'https://thepalacedanbury.com/'],
  ['Infinity Music Hall', 'https://www.infinityhall.com/Events/'],
  ['Warner Theatre', 'https://www.warnertheatre.org/events/'],
  ['Danbury (town)', 'https://www.danbury-ct.gov/calendar.aspx'],
  ['Brookfield (town)', 'https://brookfieldct.gov/calendar'],
  ['New Milford Chamber', 'https://newmilford-chamber.com/events/'],
  ['Ridgefield Chamber', 'https://chamber.inridgefield.com/events/'],
  ['The Aldrich Museum', 'https://thealdrich.org/events'],
  ['Ridgefield Library', 'https://ridgefieldlibrary.librarymarket.com/events/upcoming'],
  ['New Milford Library', 'https://newmilford.libcal.com/'],
  ['Sherman Library', 'https://www.shermanlibrary.org/monthly-calendar'],
];

const todayLabel = new Date().toLocaleDateString('en-US', {
  month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York',
});

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

const client = new Anthropic({ maxRetries: 5 }); // reads ANTHROPIC_API_KEY; retry 429/5xx/overloaded

// Stream (avoids connection timeouts on long web-tool research) and resume on
// pause_turn (server-tool loop hit its iteration cap). Returns the final message.
async function research(prompt) {
  let messages = [{ role: 'user', content: prompt }];
  let msg;
  for (let i = 0; i < 8; i++) {
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 48000, // headroom for the full events JSON (more sources = more events)
      thinking: { type: 'disabled' }, // deterministic output; tool use still works
      // Basic tool variants (no code-execution dynamic filtering) so paused turns
      // resume with a plain resend — no container_id juggling.
      tools: [
        { type: 'web_search_20250305', name: 'web_search', max_uses: 40 },
        { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 20 },
      ],
      messages,
    });
    msg = await stream.finalMessage();
    if (msg.stop_reason === 'pause_turn') {
      messages = [{ role: 'user', content: prompt }, { role: 'assistant', content: msg.content }];
      continue;
    }
    break;
  }
  return msg;
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) return fail('ANTHROPIC_API_KEY not set');

  const file = await readFile(INDEX, 'utf8');
  const startIdx = file.indexOf(START);
  const endIdx = file.indexOf(END);
  if (startIdx === -1 || endIdx === -1) return fail('EVENTS_DATA markers not found in index.html');
  const blockStart = file.indexOf('\n', startIdx) + 1; // content begins after the START comment line
  const existingBlock = file.slice(blockStart, endIdx).trim();

  const sourceList = SOURCES.map(([name, url]) => `- ${name}: ${url}`).join('\n');

  const prompt = `You maintain a curated local events guide for the Candlewood Lake area (Fairfield & Litchfield Counties, Connecticut). Today is ${todayLabel} (America/New_York).

Use the web_search and web_fetch tools to research CURRENT upcoming events (today through about 6 weeks out) around Candlewood Lake. First fetch and check these priority source calendars, then web_search each town and venue for current concerts, festivals, markets, and family events:
${sourceList}

Also search the towns directly: Sherman, New Fairfield, New Milford, Danbury, Brookfield, Ridgefield, Kent, Washington, Woodbury, Roxbury.

From Litchfield Magazine (litchfieldmagazine.com/things-to-do), include the BEST standout weekend picks even when they are a bit farther out in Litchfield County (e.g., Woodbury, Roxbury, Norfolk, Washington, Kent, New Milford). Open the individual event pages as needed to confirm the venue, town, date, and time; omit any you cannot confirm.

RULES:
- Ground every event in a real source and set a real sourceUrl. Do NOT invent events, dates, times, or prices. Accuracy over volume — omit anything you cannot confirm.
- Every event must be today (${todayLabel}) or later; set isPast to false and leave the past[] array empty ([]).
- Recompute isTonight and rebuild tonight[]; every tonight[] entry MUST have a real name, venue, and time (omit any you cannot fill completely).
- Set "lastUpdated" to "${todayLabel}".
- Score each event: score = Proximity*0.4 + FunQuality*0.6, rounded to one decimal. Proximity by town: Sherman=10, New Fairfield=9.5, New Milford=9.5, Brookfield=8.5, Danbury=8, Ridgefield=8, Kent=7.5, New Preston/Washington=7.5, Woodbury=7.5, Roxbury=7.5, Caramoor=7.5, Westport/Levitt=6.5. FunQuality is your 0-10 judgment.
- Live music is the heart of this guide. When you find a live-music act, web_search the artist/band BEFORE scoring to gauge who they are and their draw, then set FunQuality by tier based on what the research actually shows:
    - National touring headliner, GRAMMY/charting/critically acclaimed artist: 9-10
    - Established regional act, well-known tribute band, or a genuine local favorite with a real following: 7.5-8.5
    - Local bar/cover/pickup band or open mic with little public profile: 6-7.5
  Do NOT inflate unknown local bands, and do NOT underrate a nationally known act just because it is playing a small room. Ground the number in the research; if you cannot find anything on an act, treat it as a local unknown (6-7.5). Live music is a priority, so a well-regarded act should surface near the top.
- Keep the daryls[] quick-reference list current from the Daryl's House content.

Reproduce the EXACT schema and field names of the CURRENT block below.

CURRENT BLOCK:
${existingBlock}

When you have finished researching, your FINAL message must be ONLY the updated EVENTS_DATA as a single pure JSON object (double-quoted keys, no JS, no comments, no code fences, no commentary).`;

  let data;
  try {
    data = await research(prompt);
  } catch (e) {
    return fail(`Anthropic request failed: ${e.message}`);
  }
  if (data.stop_reason === 'refusal') return fail('model refused the request');

  let text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  if (!text.startsWith('{')) {
    const a = text.indexOf('{'), b = text.lastIndexOf('}');
    if (a >= 0 && b > a) text = text.slice(a, b + 1);
  }

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
  const count = obj.weeks.reduce((a, w) => a + (Array.isArray(w.events) ? w.events.length : 0), 0);
  if (count === 0) return fail('generated JSON has zero events — refusing to publish an empty guide');

  const newBlock = `const EVENTS_DATA = ${JSON.stringify(obj, null, 2)};`;
  if (newBlock.trim() === existingBlock) {
    console.log('No changes.');
    await notifySlack(`Daily events refresh (${todayLabel}): no changes.`);
    return;
  }

  const updated = file.slice(0, blockStart) + newBlock + '\n' + file.slice(endIdx);
  await writeFile(INDEX, updated);

  console.log(`Updated: ${count} events across ${obj.weeks.length} weeks.`);
  await notifySlack(`Daily events refresh (${todayLabel}): ${count} events across ${obj.weeks.length} weeks published.`);
}

main().catch((e) => fail(e.message));
