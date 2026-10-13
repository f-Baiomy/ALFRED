// A stand-in for `claude -p --output-format stream-json --include-partial-messages` in the live runner's tests: reads
// the prompt on stdin, writes it to FAKE_CLAUDE_PROMPT, then streams what a run that looks at a call and replies would.
// FAKE_CLAUDE_MODE: ok (default) | fail | slow (waits 20 s after its first step - for Stop).
import { writeFileSync } from 'node:fs';

const mode = process.env.FAKE_CLAUDE_MODE || 'ok';
let prompt = '';
process.stdin.on('data', (d) => { prompt += d; });
process.stdin.on('end', async () => {
  if (process.env.FAKE_CLAUDE_PROMPT) writeFileSync(process.env.FAKE_CLAUDE_PROMPT, JSON.stringify({ prompt, args: process.argv.slice(2) }));
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  out({ type: 'system', subtype: 'init' });
  if (mode === 'listen') {
    // a listen batch / finish run: drills in, adds two cards in one call, ends with its summary and STATE
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__alfred-t__investigate_call', input: { callId: 'in-err-1' } }] } });
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__alfred-t__board_add_many', input: { cards: [{ title: 'a' }, { title: 'b' }] } }] } });
    const n = (prompt.match(/THE SWEEP/) ? 'finish' : 'batch');
    out({ type: 'result', subtype: 'success', is_error: false,
      result: `Judged.\n→ ${n}: 2 cards · 1 fine\n• #14 BUG GET /api/confirm 500 - boom (call #2)\n• #15 TASK no log line for the 500 (call #2)\n<<<STATE\nflow search→book · sure: fare unchanged · seen in ${n}\nSTATE>>>` });
    return;
  }
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__alfred__investigate_call', input: { callId: 'in-confirm-123456789' } }] } });
  await wait(mode === 'slow' ? 20000 : 50);
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'C:/repo/src/OrderMapper.java', offset: 58 } }] } });
  if (mode === 'fail') {
    out({ type: 'result', subtype: 'error', is_error: true, result: 'API Error: overloaded' });
    process.exit(1);
  }
  out({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', name: 'mcp__alfred__board_reply' } } });
  for (const part of ['{"project":"p","number":12,"text":"Not right. Confirm', ' returned 437.50', ' but the booking saved 412.00."}']) {
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: part } } });
    await wait(20);
  }
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__alfred__board_reply',
    input: { project: 'p', number: 12, text: 'Not right. Confirm returned 437.50 but the booking saved 412.00.' } }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'Done.\n→ replied; the saved fare is the search fare' });
});
