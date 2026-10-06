// One-off live check of the specs/010 tools against a running Alfred (not part of the test suite):
//   npx tsx scripts/live-010.ts [http://localhost:3000]
import { connect } from '../test/harness.ts';

const base = process.argv[2] ?? 'http://localhost:3000';
const h = await connect(base);
const show = (name: string, text: string) => console.log(`\n=== ${name}\n${text.length > 1500 ? `${text.slice(0, 1500)}… (${text.length} chars)` : text}`);
try {
  const problems = await h.call('problem_calls', { scope: { all: true }, all: ['LOG_ERROR'], none: ['HTTP_ERROR'], limit: 3 });
  show('problem_calls 2xx that logged an error', problems.text);
  const first = problems.json?.calls?.[0]?.callId as string | undefined;
  show('search_logs FileNotFoundException', (await h.call('search_logs', { text: 'FileNotFoundException', scope: { all: true }, limit: 2 })).text);
  show('log_problems', (await h.call('log_problems', { scope: { all: true }, limit: 3 })).text);
  show('endpoint_health', (await h.call('endpoint_health', { limit: 3 })).text);
  if (first) {
    show(`investigate_call ${first}`, (await h.call('investigate_call', { callId: first })).text);
    show('call_story firstError', (await h.call('call_story', { callId: first, startAt: 'firstError', limit: 6 })).text);
  }
  show('triage cycle widest', (await h.call('triage', { scope: { all: true }, limit: 2 })).text);
} finally {
  await h.close();
}
