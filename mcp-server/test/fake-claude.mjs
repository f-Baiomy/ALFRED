// A stand-in for `claude -p --output-format stream-json --include-partial-messages` in the runners' tests. With
// `--input-format stream-json` (the warm pool) it prints its init event at once, then takes the prompt from the first
// user message on stdin; otherwise it reads the prompt until stdin ends. It writes the prompt and its arguments to
// FAKE_CLAUDE_PROMPT, then streams what a run that looks at a call and replies would.
// FAKE_CLAUDE_MODE: ok (default) | fail | fail-once (fails the first run after the marker file is absent, then ok) |
// slow (waits 20 s after its first step - for Stop) | listen (a listen batch / finish run) | text-only (answers in
// text, no board write).
import { existsSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

let mode = process.env.FAKE_CLAUDE_MODE || 'ok';
const streamIn = process.argv.includes('--input-format');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
if (streamIn) out({ type: 'system', subtype: 'init', tools: [] });

async function answer(prompt) {
  if (process.env.FAKE_CLAUDE_PROMPT) writeFileSync(process.env.FAKE_CLAUDE_PROMPT, JSON.stringify({ prompt, args: process.argv.slice(2) }));
  if (mode === 'fail-once') {
    const marker = `${process.env.FAKE_CLAUDE_PROMPT}.failed`;
    if (!existsSync(marker)) { writeFileSync(marker, '1'); mode = 'fail'; } else mode = /THE BATCH|THE SWEEP/.test(prompt) ? 'listen' : 'ok';
  }
  if (!streamIn) out({ type: 'system', subtype: 'init' });
  if (mode === 'listen') {
    // a listen batch / finish run: drills in, adds two cards in one call, ends with its summary, findings and blocks
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__alfred-t__investigate_call', input: { callId: 'in-err-1' } }] } });
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'call seen' }] }] } });
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'mcp__alfred-t__board_add_many', input: { cards: [{ title: 'a' }, { title: 'b' }] } }] } });
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: '{"results":["added #14 \\"a\\"","added #15 \\"b\\""]}' }] }] } });
    const n = (prompt.match(/THE SWEEP/) ? 'finish' : 'batch');
    const groups = [...prompt.matchAll(/^G(\d+) · /gm)].map((m) => `G${m[1]}`);
    const ledger = groups.map((g, i) => (i === 0 ? `${g} = card #14` : i === 1 ? `${g} = link #9` : `${g} = fine: a 404 the user caused on purpose`)).join('\n');
    out({ type: 'result', subtype: 'success', is_error: false,
      result: `Judged.\n→ ${n}: 2 cards · 1 fine\n• #14 BUG GET /api/confirm 500 - boom (call #2)\n• #15 TASK no log line for the 500 (call #2)\n`
        + `LEDGER\n${ledger}\nUNSURE\nbooking | fare.total | 412.00→437.50 | in-ok-1→in-err-1 | ask\nCODE\nGET /api/confirm | src/Confirm.java:12 | re-fetches the fare\nCHECK\n- booking: fare.total may change at confirm\n`
        + `STATE\nflow search→book · sure: fare unchanged · seen in ${n}\n` });
    return;
  }
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__alfred__investigate_call', input: { callId: 'in-confirm-123456789' } }] } });
  await wait(mode === 'slow' ? 20000 : 50);
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'C:/repo/src/OrderMapper.java', offset: 58 } }] } });
  if (mode === 'fail') {
    out({ type: 'result', subtype: 'error', is_error: true, result: 'API Error: overloaded' });
    process.exit(1);
  }
  if (mode === 'text-only') {
    out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Not right. Confirm returned 437.50.' }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'Not right. Confirm returned 437.50.\n→ answered' });
    return;
  }
  out({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', name: 'mcp__alfred__board_reply' } } });
  for (const part of ['{"project":"p","number":12,"text":"Not right. Confirm', ' returned 437.50', ' but the booking saved 412.00."}']) {
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: part } } });
    await wait(20);
  }
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't3', name: 'mcp__alfred__board_reply',
    input: { project: 'p', number: 12, text: 'Not right. Confirm returned 437.50 but the booking saved 412.00.' } }] } });
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't3', content: [{ type: 'text', text: '{"replied":true}' }] }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'Done.\n→ replied; the saved fare is the search fare' });
}

if (streamIn) {
  const rl = createInterface({ input: process.stdin });
  let taken = false;
  rl.on('line', (line) => {
    if (taken || !line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.type !== 'user') return;
    taken = true;
    const content = msg.message?.content;
    const prompt = typeof content === 'string' ? content : (content ?? []).map((c) => c.text ?? '').join('\n');
    answer(prompt).then(() => { /* the pool closes stdin after the result */ });
  });
  rl.on('close', () => process.exit(0));
} else {
  let prompt = '';
  process.stdin.on('data', (d) => { prompt += d; });
  process.stdin.on('end', () => answer(prompt).then(() => process.exit(0)));
}
