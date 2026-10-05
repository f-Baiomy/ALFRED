/**
 * The spec's live scenario against the RUNNING Alfred (npm run live-check [-- --pause]). Everything it
 * creates is named mcp-live-* and removed in `finally`, so a failed run leaves nothing behind.
 * --pause stops after the writes so a person (or the browser pane) can check the open UI shows them
 * without a reload, then cleans up on Enter.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { connect } from '../test/harness.ts';

const BASE = process.env['ALFRED_URL'] || 'http://localhost:3000';
const CALL = '500d0cdc-ed5b-459e-9afa-ef7c2996949f';
// --pause waits for Enter; --pause=90 waits 90 s (for a run with no terminal, e.g. driven from a browser check).
const pauseArg = process.argv.find((a) => a.startsWith('--pause'));
const PAUSE = pauseArg !== undefined;
const PAUSE_SECONDS = pauseArg?.includes('=') ? Number(pauseArg.split('=')[1]) : null;
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}\n`);
}

async function raw(method: string, path: string): Promise<number> {
  return (await fetch(BASE + path, { method })).status;
}

const h = await connect(BASE);
const created: { comment?: string; cycles: string[]; dir?: string } = { cycles: [] };
try {
  // ---- read: the flight search call and its database findings (SC-002)
  const overview = await h.call('db_overview', { callId: CALL });
  const findings: { source: string; seqs: number[] }[] = overview.json?.findings ?? [];
  const fanOut = findings.find((f) => f.source === 'QUERY_FAN_OUT');
  const swallowed = findings.find((f) => f.source === 'FAILED_SWALLOWED');
  check('overview: summary line', typeof overview.json?.summary === 'string' && overview.json.summary.length > 0, overview.json?.summary);
  check('overview: HQL fan-out #19-#25', JSON.stringify(fanOut?.seqs) === JSON.stringify([19, 20, 21, 22, 23, 24, 25]));
  check('overview: swallowed failure at #42', !!swallowed?.seqs.includes(42));
  const failed = await h.call('db_statements', { callId: CALL, failedOnly: true });
  const st42 = failed.json?.statements?.find((s: { seq: number }) => s.seq === 42);
  check('db_statements: #42 listed as failed', !!st42);
  const detail = await h.call('db_statement', { statementId: st42?.id ?? 0, rowsLimit: 0 });
  check('db_statement #42: call chain present', !!(detail.json?.callers?.length || detail.json?.codeLocation), detail.json?.callers?.[0] ?? detail.json?.codeLocation);

  // ---- triage: the saved marks (a 200 hiding a swallowed failed statement is priority 4)
  const marked = await h.call('get_call', { id: CALL, fields: ['status'] });
  const full = await h.call('get_call', { id: CALL, bodyLength: 256 });
  check('get_call: the flight search is priority 4 (succeeded, a statement under it failed)', full.json?.attention?.priority === 4,
    JSON.stringify(full.json?.attention ?? marked.text.slice(0, 120)));
  check('get_call: dbFailures names #42 from the failed-statement index', full.json?.dbFailures?.statements?.some((s: { seq: number }) => s.seq === 42));
  const flow = (await h.call('list_cycles', {})).json?.cycles?.find((c: { name: string }) => c.name.includes('user flow'));
  if (flow) {
    const triaged = await h.call('triage', { cycle: flow.id });
    check('triage on the user-flow cycle: the 307 and the 401 are other failed calls',
      /3 · Other failed calls[\s\S]*userDetails → 307[\s\S]*loginAction → 401|3 · Other failed calls[\s\S]*loginAction → 401[\s\S]*userDetails → 307/.test(triaged.text),
      triaged.text.split('\n').slice(0, 3).join(' | '));
    check('triage on the user-flow cycle: the flight search is a hidden failure with its failed statement',
      /4 · Succeeded, but something under it failed[\s\S]*flight-search\/search → 200[\s\S]*✖ DB #\d+ CALL LOG_FLIGHTSEARCH_HIT_DETAILS_SP_V6 failed 42000/.test(triaged.text));
    const story = await h.call('get_cycle', { cycle: flow.id, limit: 1, includeDb: false, includeComments: false });
    check('get_cycle opens with the attention line', /^Needs attention - .*3: #\d+ \(307\)/m.test(story.text), story.text.split('\n')[1]);
  } else {
    process.stdout.write('SKIP  triage on the user-flow cycle - no cycle named "user flow"\n');
  }
  const live = await h.call('triage', { project: 'odeysys', minutes: 10_080 });
  check('triage on live calls answers with groups and totals', !live.isError && typeof live.json?.totals === 'object', live.isError ? live.text : JSON.stringify(live.json?.totals));

  // ---- write: comment, cycle, copy, spacer
  const comment = await h.call('add_comment', { callId: CALL, block: 'request-body', lineMatch: 'DXB', comment: `mcp live check ${stamp}` });
  created.comment = comment.json?.id;
  check('add_comment', !comment.isError && comment.json?.comment?.startsWith('🤖 Claude: '), comment.isError ? comment.text : `line ${comment.json?.line}`);

  const cycle = await h.call('create_cycle', { name: `mcp-live-check-${stamp}`, calls: [{ id: CALL }] });
  const cycleId: string | undefined = cycle.json?.cycle?.id;
  if (cycleId) created.cycles.push(cycleId);
  check('create_cycle from a live call', cycle.json?.copy?.added === 1, cycle.text.slice(0, 200));
  const spacer = await h.call('add_spacer', { cycleId, label: 'search', afterCallId: 'top' });
  check('add_spacer above the call', !spacer.isError && spacer.json?.afterCallId == null, spacer.isError ? spacer.text : '');
  const story = await h.call('get_cycle', { cycle: cycleId });
  check('get_cycle: spacer, call, comment and DB line in the story',
    /── search ──[\s\S]*#1 .*id=500d0cdc[\s\S]*💬[\s\S]*◆ DB:/.test(story.text), story.text.split('\n').length + ' lines');

  // ---- search inside the cycle, and a call compared with its own cycle copy
  const found = await h.call('search_cycle', { cycle: cycleId, text: 'flight-search' });
  check('search_cycle finds the copied call as #1', found.json?.calls?.[0]?.id === CALL && found.json.calls[0].n === 1, found.isError ? found.text : '');
  const same = await h.call('diff_calls', { a: CALL, b: CALL, bCycleId: cycleId });
  check('diff_calls: the live call and its cycle copy are identical', same.json?.request?.body?.identical === true && same.json?.response?.body?.identical === true,
    same.isError ? same.text : '');

  // ---- read-only views and the project switches (no switch is flipped here)
  const rules = await h.call('list_rules', {});
  check('list_rules', !rules.isError && Array.isArray(rules.json?.rules), `${rules.json?.total} rules`);
  const relive = await h.call('list_relive_cycles', {});
  check('list_relive_cycles', !relive.isError && Array.isArray(relive.json?.cycles), `${relive.json?.total} cycles`);
  const projects = await h.call('list_projects', {});
  const odeysys = projects.json?.projects?.find((p: { name: string }) => p.name === 'odeysys');
  check('list_projects shows odeysys and its switches', !!odeysys && typeof odeysys.inboundLogging === 'boolean');
  const ask = await h.call('set_inbound_logging', { project: 'odeysys', enabled: !odeysys?.inboundLogging });
  check('set_inbound_logging without confirm only asks', ask.json?.needsConfirm === true);
  const prompts = await h.client.listPrompts();
  check('prompts listed', prompts.prompts.some((p) => p.name === 'debug_cycle'));
  if (process.env['ALFRED_SOURCE_ROOT']) {
    const located = await h.call('locate_source', { frames: ['GenericDAOImpl.executeSQLQuery(GenericDAOImpl.java:927)'] });
    check('locate_source finds GenericDAOImpl', !!located.json?.frames?.[0]?.source, located.json?.frames?.[0]?.source ?? located.text);
  } else {
    process.stdout.write('SKIP  locate_source - set ALFRED_SOURCE_ROOT to the odeysys checkout to check it\n');
  }

  // ---- export .md/.json/.html into a temp folder set for the session
  created.dir = await mkdtemp(join(tmpdir(), 'mcp-live-'));
  const noPath = await h.call('export_calls', { format: 'md', cycleId });
  check('export without a location asks for one', noPath.json?.needsPath === true);
  await h.call('session_settings', { exportFolder: created.dir });
  for (const format of ['md', 'json', 'html'] as const) {
    const r = await h.call('export_calls', { format, cycleId });
    const content = r.json?.path ? await readFile(r.json.path, 'utf8') : '';
    check(`export .${format}`, !r.isError && r.json.bytes > 1000 && content.includes('flight-search/search'), r.isError ? r.text : `${r.json.bytes} bytes`);
  }

  // ---- recording (SC-009): two marker requests between start and stop, one after
  const services: { name: string; listenPort: number | null; enabled: boolean }[] = await (await fetch(`${BASE}/internal-calls/services`)).json();
  const project = services.find((s) => s.enabled && s.listenPort);
  if (!project) {
    process.stdout.write('SKIP  recording - no project with inbound logging on\n');
  } else {
    const rec = await h.call('create_cycle', { name: `mcp-live-rec-${stamp}` });
    const recId: string = rec.json.cycle.id;
    created.cycles.push(recId);
    const started = await h.call('start_recording', { cycleId: recId });
    check('start_recording', started.json?.cycle?.status === 'RECORDING' && started.json?.changed === true);
    const again = await h.call('start_recording', { cycleId: recId });
    check('start_recording again changes nothing', again.json?.changed === false);
    const marker = `/mcp-live-check-${stamp}`;
    // wait_for_calls is started first and must wake on the socket signal of the first marker call.
    const waiting = h.call('wait_for_calls', { cycleId: recId, timeoutSec: 30 });
    await new Promise((r) => setTimeout(r, 1000));
    const sentAt = Date.now();
    await fetch(`http://127.0.0.1:${project.listenPort}${marker}?n=1`).catch(() => undefined);
    const woke = await waiting;
    check('wait_for_calls wakes on the new call (event, not timeout)', woke.json?.timedOut === false && woke.json.newCalls.some((c: { url: string }) => c.url.includes(`${marker}?n=1`)),
      `${Date.now() - sentAt} ms after the request`);
    await fetch(`http://127.0.0.1:${project.listenPort}${marker}?n=2`).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 1500));
    const stopped = await h.call('stop_recording', { cycleId: recId });
    check('stop_recording', stopped.json?.cycle?.status === 'PAUSED');
    await fetch(`http://127.0.0.1:${project.listenPort}${marker}?n=3`).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 2000));
    const recorded = await h.call('get_cycle', { cycle: recId, limit: 200, includeDb: false, includeComments: false });
    const has = (n: number) => recorded.text.includes(`${marker}?n=${n}`);
    check('recording holds the calls made between start and stop', has(1) && has(2), `${recorded.json?.totalCalls} calls`);
    check('recording does not hold the call made after stop', !has(3));
  }

  if (PAUSE) {
    process.stdout.write(`\nPAUSED with test data in place (cycle mcp-live-check-${stamp}). ${PAUSE_SECONDS ? `Cleaning up in ${PAUSE_SECONDS} s.` : 'Check the UI, then press Enter to clean up.'}\n`);
    if (PAUSE_SECONDS) {
      await new Promise((r) => setTimeout(r, PAUSE_SECONDS * 1000));
    } else {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      await rl.question('');
      rl.close();
    }
  }
} finally {
  // ---- cleanup: comment through the tool, cycles directly (cycle deletion is deliberately not a tool)
  if (created.comment) {
    const del = await h.call('delete_comment', { commentId: created.comment });
    check('cleanup: test comment deleted', !del.isError);
  }
  for (const id of created.cycles) {
    await raw('POST', `/session-cycles/${id}/pause`);
    const status = await raw('DELETE', `/session-cycles/${id}`);
    check(`cleanup: test cycle ${id} deleted`, status === 204, String(status));
  }
  const left = await h.call('list_comments', { callId: CALL });
  check('cleanup: no test comment left', !left.text.includes(`mcp live check ${stamp}`));
  if (created.dir) await rm(created.dir, { recursive: true, force: true });
  await h.close();
}
process.stdout.write(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
