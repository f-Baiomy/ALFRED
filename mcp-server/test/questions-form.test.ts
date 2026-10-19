import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { crc32, deflateRawSync } from 'node:zlib';
import { JSDOM } from 'jsdom';
import { AnswersFileError, extractAnswers, readAnswersFile, unzipAnswers, BAD_ZIP, NOT_ANSWERS, TOO_BIG } from '../src/answers-file.ts';
import { world } from './harness.ts';
import { session } from '../src/session.ts';

/**
 * specs/037: the questions form Alfred renders (specs/037-questions-form/fixtures/form-*.html, written by the backend's
 * QuestionsFormTest) driven as a person would - pick, follow-up, other, later, how sure, language - then the answers file
 * it downloads (.html and .zip) read back here exactly as answered; and the three MCP tools against the fake Alfred.
 * ALFRED_FIXTURES=write regenerates the answers fixtures the backend's AnswersFileTest reads.
 */
const FIX = new URL('../../specs/037-questions-form/fixtures/', import.meta.url);
const WRITE = process.env['ALFRED_FIXTURES'] === 'write';
/** A value out of the jsdom window as a plain Node value (its arrays are another realm's). */
const plain = (x: unknown): any => JSON.parse(JSON.stringify(x));

interface Opened { w: any; blobs: Blob[]; names: string[]; confirms: string[] }

function open(name: string, answerConfirm = true, storage: Record<string, string> | null = {}): Opened {
  const html = readFileSync(new URL(name, FIX), 'utf8');
  const blobs: Blob[] = [];
  const names: string[] = [];
  const confirms: string[] = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', url: 'http://form.local/questions.html', pretendToBeVisual: true,
    beforeParse(w: any) {
      w.TextEncoder = TextEncoder;
      if (storage === null) Object.defineProperty(w, 'localStorage', { get() { throw new Error('SecurityError'); } });
      else for (const [k, v] of Object.entries(storage)) w.localStorage.setItem(k, v);
      w.Blob = Blob;
      w.confirm = (m: string) => { confirms.push(m); return answerConfirm; };
      w.URL.createObjectURL = (b: Blob) => { blobs.push(b); return 'blob:x'; };
      w.URL.revokeObjectURL = () => undefined;
      w.HTMLElement.prototype.scrollIntoView = () => undefined;
      const click = w.HTMLAnchorElement.prototype.click;
      w.HTMLAnchorElement.prototype.click = function (this: any) { if (this.download) names.push(this.download); else click.call(this); };
    },
  });
  return { w: dom.window, blobs, names, confirms };
}

function pick(w: any, name: string, value: string): void {
  const input = [...w.document.querySelectorAll('input')].find((x: any) => x.name === name && x.value === value);
  assert.ok(input, `no input ${name}=${value}`);
  input.click();
}

function note(w: any, q: string, text: string): void {
  const t = w.document.querySelector(`[data-note="${q}"]`);
  t.value = text;
  t.dispatchEvent(new w.Event('input', { bubbles: true }));
}

function fill(w: any): void {
  w.document.getElementById('name').value = 'Ahmed </script><b>Ghonim</b>';
  w.document.getElementById('role').value = 'BA';
  pick(w, 'q1', 'o1');
  pick(w, 'q1.s', 'sure');
  pick(w, 'q2', 'o1');
  pick(w, 'q2.f.o1', 'o2');
  pick(w, 'q3', 'o1');
  pick(w, 'q3', 'o3');
  pick(w, 'q3', '__other');
  note(w, 'q3', 'plus Status');
  note(w, 'q4', 'Mona from DevOps');
}

test('the form shows every question, its details and its follow-up only when its option is picked', () => {
  const { w } = open('form-mixed.html');
  const d = w.document;
  assert.match(d.getElementById('prog').textContent, /0 of 4 answered/);
  assert.equal(d.querySelectorAll('.q').length, 4);
  assert.equal(d.querySelectorAll('.grp').length, 3);
  assert.ok(d.querySelector('#q-q1 .det .dbody table'), 'the details table is shown');
  assert.ok(d.querySelector('#q-q1 .det .fd-stats'), 'the stats are shown');
  assert.equal(d.querySelector('#q-q2 .fu').classList.contains('show'), false);
  pick(w, 'q2', 'o1');
  assert.equal(d.querySelector('#q-q2 .fu').classList.contains('show'), true);
  pick(w, 'q2', 'o2');
  assert.equal(d.querySelector('#q-q2 .fu').classList.contains('show'), false);
  // a free question has no options, only "later" and the answer box
  assert.equal(d.querySelectorAll('#q-q4 input[name="q4"]').length, 1);
  assert.match(d.getElementById('prog').textContent, /1 of 4 answered/);
});

test('language: auto picks the language most questions are in; the reader switches and the page turns', () => {
  const ar = open('form-ar.html').w;
  assert.equal(ar.document.documentElement.dir, 'rtl');
  assert.match(ar.document.getElementById('save').textContent, /تنزيل الإجابات/);
  const en = open('form-en.html').w;
  assert.equal(en.document.documentElement.dir, 'ltr');
  en.document.querySelector('#lang [data-l="ar"]').click();
  assert.equal(en.document.documentElement.dir, 'rtl');
  assert.equal(en.document.documentElement.lang, 'ar');
  // a text the board wrote keeps its own direction
  assert.equal(en.document.querySelector('.q h2').getAttribute('dir'), 'auto');
});

test('round trip: what was answered is exactly what the answers file carries, .html and .zip', async () => {
  const o = open('form-mixed.html');
  fill(o.w);
  const collected = JSON.parse(JSON.stringify(plain(o.w.AlfredForm.collect())));
  assert.deepEqual(collected.answers.map((a: any) => a.q), ['q1', 'q2', 'q3', 'q4']);
  assert.deepEqual(collected.answers[1].follow, { q: 'f1', choice: ['o2'] });
  assert.deepEqual(collected.answers[2], { q: 'q3', choice: ['o1', 'o3'], other: true, later: false, note: 'plus Status', sure: null, follow: null });

  o.w.document.getElementById('save').click();
  assert.equal(o.confirms.length, 0, 'everything answered: no warning');
  const html = await o.blobs[0].text();
  assert.match(o.names[0], /^AB62565-answers-\d{4}-\d{2}-\d{2}\.html$/);
  const read = extractAnswers(html);
  const { answeredAt: _a, ...rest } = read as any;
  const { answeredAt: _b, ...expected } = collected;
  assert.deepEqual(rest, expected);
  assert.equal((read as any).answeredBy, 'Ahmed </script><b>Ghonim</b>');

  // the answers page runs nothing: its only script is the JSON block, and it has no form controls
  const page = new JSDOM(html).window.document;
  assert.deepEqual([...page.querySelectorAll('script')].map((s: any) => s.getAttribute('type')), ['application/json']);
  assert.equal(page.querySelectorAll('input, textarea, button, select').length, 0);
  assert.ok(page.querySelector('.stats'));
  assert.equal(page.querySelector('bdi').textContent, 'Ahmed </script><b>Ghonim</b>');

  o.w.document.getElementById('saveZip').click();
  const zip = new Uint8Array(await o.blobs[1].arrayBuffer());
  assert.match(o.names[1], /\.zip$/);
  const fromZip = readAnswersFile(o.names[1], zip) as any;
  assert.deepEqual(fromZip.answers, collected.answers);

  if (WRITE) {
    writeFileSync(new URL('answers-ok.html', FIX), html);
    writeFileSync(new URL('answers-ok.zip', FIX), zip);
    writeFileSync(new URL('answers-ok.expected.json', FIX), JSON.stringify(read, null, 2) + '\n');
  }
});

test('download warns about open questions and an "other answer" with no note', async () => {
  const o = open('form-mixed.html', false);
  pick(o.w, 'q3', '__other');
  o.w.document.getElementById('save').click();
  assert.equal(o.confirms.length, 1);
  assert.match(o.confirms[0], /3 question\(s\) have no answer\. 1 "Other answer" have no notes\./);
  assert.equal(o.blobs.length, 0, 'cancelled: nothing downloaded');
});

test('"later" and an answer exclude each other, also in a multi-select question; accept all recommended fills the rest', () => {
  const { w } = open('form-mixed.html');
  pick(w, 'q3', 'o1');
  pick(w, 'q3', '__later');
  let a = plain(w.AlfredForm.collect()).answers[2];
  assert.deepEqual([a.choice, a.later], [[], true]);
  pick(w, 'q3', 'o2');
  a = plain(w.AlfredForm.collect()).answers[2];
  assert.deepEqual([a.choice, a.later], [['o2'], false]);

  w.document.getElementById('acceptRec').click();
  const all = plain(w.AlfredForm.collect()).answers;
  assert.deepEqual(all[0].choice, ['o1']);
  assert.deepEqual(all[1].follow, { q: 'f1', choice: ['o2'] });
});

test('answers survive closing the page (saved on this device), and a browser that cannot save still works', () => {
  const first = open('form-mixed.html');
  pick(first.w, 'q1', 'o2');
  note(first.w, 'q4', 'later today');
  const saved: Record<string, string> = {};
  for (let i = 0; i < first.w.localStorage.length; i++) saved[first.w.localStorage.key(i)] = first.w.localStorage.getItem(first.w.localStorage.key(i));
  assert.match(first.w.document.getElementById('savedAt').textContent, /Saved on this device/);

  const again = open('form-mixed.html', true, saved);
  const a = plain(again.w.AlfredForm.collect()).answers;
  assert.deepEqual(a[0].choice, ['o2']);
  assert.equal(a[3].note, 'later today');

  const blocked = open('form-mixed.html', true, null);
  pick(blocked.w, 'q1', 'o1');
  assert.deepEqual(plain(blocked.w.AlfredForm.collect()).answers[0].choice, ['o1']);
  assert.match(blocked.w.document.getElementById('savedAt').textContent, /does not save/);
});

// ------------------------------------------------------------------------------------------------- the file reader

const okHtml = () => readFileSync(new URL('answers-ok.html', FIX), 'utf8');
const expected = () => JSON.parse(readFileSync(new URL('answers-ok.expected.json', FIX), 'utf8'));

function refused(fn: () => unknown, message: string | RegExp): void {
  assert.throws(fn, (e: unknown) => e instanceof AnswersFileError && (typeof message === 'string' ? e.message === message : message.test(e.message)));
}

/** A one-entry zip by hand (deflated), for the archive checks. */
function zipOf(entries: { name: string; data: Buffer; flags?: number }[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const data = deflateRawSync(e.data);
    const name = Buffer.from(e.name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(e.flags ?? 0, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc32(e.data), 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(e.data.length, 22); lh.writeUInt16LE(name.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(e.flags ?? 0, 8); cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(crc32(e.data), 16); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(e.data.length, 24); cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(offset, 42);
    locals.push(lh, name, data);
    central.push(cd, name);
    offset += 30 + name.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, end]);
}

test('the reader takes only the JSON block and refuses everything else', () => {
  assert.deepEqual(extractAnswers(okHtml()), expected());
  const html = okHtml();
  refused(() => extractAnswers(html.replace('"version":1', '"version":7')), 'Unknown answers file version 7');
  refused(() => extractAnswers('<html><body><p>hello</p></body></html>'), NOT_ANSWERS);
  refused(() => extractAnswers('<script>alert(1)</script>'), NOT_ANSWERS);
  refused(() => extractAnswers(html.replace('id="alfred-answers">', 'id="alfred-answers">{not json')), NOT_ANSWERS);
  refused(() => extractAnswers(html.replace(/"formId":"qf_[0-9a-f]+"/, '"formId":"x"')), NOT_ANSWERS);
  refused(() => readAnswersFile('a.html', Buffer.alloc(2 * 1024 * 1024 + 1, 0x41)), TOO_BIG);
  // scripts around the block do not run: jsdom's defaults, and the block still reads
  let ran = false;
  (globalThis as any).__ran = () => { ran = true; };
  const wrapped = `<script>globalThis.__ran()</script>${html}<img src=x onerror="globalThis.__ran()">`;
  assert.deepEqual(extractAnswers(wrapped).answers, expected().answers);
  assert.equal(ran, false);
});

test('a .zip is opened only when it holds one answers page, and never past the size limit', () => {
  const page = Buffer.from(okHtml());
  assert.deepEqual(readAnswersFile('a.zip', readFileSync(new URL('answers-ok.zip', FIX))).answers, expected().answers);
  assert.deepEqual(readAnswersFile('a.zip', zipOf([{ name: 'AB-answers.html', data: page }, { name: '__MACOSX/._AB-answers.html', data: Buffer.from('x') }])).answers,
    expected().answers);
  refused(() => readAnswersFile('a.zip', zipOf([{ name: 'a.html', data: page }, { name: 'b.html', data: page }])), BAD_ZIP);
  refused(() => readAnswersFile('a.zip', zipOf([{ name: 'notes.txt', data: Buffer.from('hi') }])), BAD_ZIP);
  refused(() => readAnswersFile('a.zip', zipOf([{ name: '../x.html', data: page }])), BAD_ZIP);
  refused(() => readAnswersFile('a.zip', zipOf([{ name: 'a.html', data: page, flags: 1 }])), BAD_ZIP);
  refused(() => readAnswersFile('a.zip', zipOf([{ name: 'bomb.html', data: Buffer.alloc(3 * 1024 * 1024, 0x20) }])), TOO_BIG);
  refused(() => readAnswersFile('a.zip', Buffer.from('PK\u0003\u0004 not really')), BAD_ZIP);
  if (WRITE) {
    writeFileSync(new URL('answers-bomb.zip', FIX), zipOf([{ name: 'bomb.html', data: Buffer.alloc(3 * 1024 * 1024, 0x20) }]));
    writeFileSync(new URL('answers-two-html.zip', FIX), zipOf([{ name: 'a.html', data: page }, { name: 'b.html', data: page }]));
    writeFileSync(new URL('answers-slip.zip', FIX), zipOf([{ name: '../x.html', data: page }]));
    writeFileSync(new URL('answers-encrypted.zip', FIX), zipOf([{ name: 'a.html', data: page, flags: 1 }]));
    writeFileSync(new URL('answers-macosx.zip', FIX), zipOf([{ name: 'AB-answers.html', data: page }, { name: '__MACOSX/._AB-answers.html', data: Buffer.from('x') }]));
  }
});

// ------------------------------------------------------------------------------------------------------- the tools

const SUMMARY = { board: { id: 'b-1', project: 'odeysys', name: 'AB#62565 Portal', isDefault: false, state: 'OPEN' }, cards: 3, cycleIds: [], boardIds: [], linkedItem: 'azure/62565' };

test('board_questions_form saves the file Alfred built and says what is in it', async () => {
  const w = await world();
  const folder = mkdtempSync(join(tmpdir(), 'alfred-form-'));
  try {
    session.exportFolder = folder;
    w.fake.extra = (method, p) => (method === 'GET' && p.join('/') === 'board/boards/b-1' ? [200, SUMMARY] : null);
    w.fake.raw = (method, path, body) => method === 'POST' && path === '/board/boards/b-1/questions-form' ? {
      status: 200, body: '<!doctype html><html>form</html>', headers: {
        'Content-Type': 'text/html; charset=utf-8', 'X-Alfred-Form-Id': 'qf_' + 'a'.repeat(32), 'X-Alfred-Form-Questions': '3',
        'X-Alfred-Form-Cards': '87,88', 'X-Alfred-Form-Name': encodeURIComponent('AB62565-questions-2026-10-19.html'),
        'X-Alfred-Form-Left-Out': encodeURIComponent('#90 has no open questions'), 'X-Fake-Body': body.toString('utf8'),
      },
    } : undefined;
    const r = await w.call('board_questions_form', { board: 'b-1', cards: [87, 88, 90] });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json.saved, join(folder, 'AB62565-questions-2026-10-19.html'));
    assert.equal(readFileSync(r.json.saved, 'utf8'), '<!doctype html><html>form</html>');
    assert.deepEqual(r.json.cards, ['#87', '#88']);
    assert.deepEqual(r.json.leftOut, ['#90 has no open questions']);
    const sent = w.fake.requests('POST', '/questions-form')[0];
    assert.deepEqual(sent.body, { cards: [87, 88, 90], lang: 'auto', format: 'html' });
    assert.equal(sent.headers?.['x-alfred-actor'], 'claude');
  } finally { await w.close(); }
});

test('board_import_answers reads the file here, sends only its answers, and applies only with askedIn', async () => {
  const w = await world();
  const folder = mkdtempSync(join(tmpdir(), 'alfred-answers-'));
  try {
    const file = join(folder, 'AB62565-answers.html');
    writeFileSync(file, okHtml());
    const ans = expected();
    w.fake.extra = (method, p, _q, body: any) => {
      if (method === 'GET' && p.join('/') === `board/boards/${ans.board}`) return [200, { ...SUMMARY, board: { ...SUMMARY.board, id: ans.board } }];
      if (method === 'POST' && p.join('/') === `board/boards/${ans.board}/answers-import`) {
        return [200, { file: { formId: ans.formId, board: ans.board, boardName: 'AB#62565 Portal', answeredBy: 'Ahmed', role: 'BA', answeredAt: '2026-10-19T14:02:00Z', lang: 'ar' },
          rows: [{ q: 'q1', card: 87, header: 'Viewed', question: 'q', choice: [{ id: 'o1', label: 'Per user' }], other: false, later: false, note: '', sure: 'sure',
            follow: null, result: body.dryRun ? 'APPLY' : 'APPLIED', message: null }], applied: body.dryRun ? 0 : 1, summary: {}, dryRun: body.dryRun }];
      }
      return null;
    };
    const dry = await w.call('board_import_answers', { path: file });
    assert.equal(dry.isError, false, dry.text);
    assert.deepEqual(dry.json.answers, ['#87 Viewed: Per user [sure] - will apply']);
    const sent = w.fake.requests('POST', '/answers-import')[0].body as any;
    assert.equal(sent.dryRun, true);
    assert.equal(sent.answers.formId, ans.formId);
    assert.equal(JSON.stringify(sent).includes('<html'), false, 'only the answers go to Alfred');

    const noAsk = await w.call('board_import_answers', { path: file, dryRun: false });
    assert.equal(noAsk.isError, true);
    assert.match(noAsk.text, /Applying answers is the user's/);
    assert.equal(w.fake.requests('POST', '/answers-import').length, 1, 'refused before any request');

    const applied = await w.call('board_import_answers', { path: file, dryRun: false, askedIn: 'terminal' });
    assert.equal(applied.isError, false, applied.text);
    assert.equal(applied.json.applied, 1);
    assert.equal((w.fake.requests('POST', '/answers-import')[1].body as any).askedIn, 'terminal');

    writeFileSync(join(folder, 'page.html'), '<html><script>alert(1)</script></html>');
    const bad = await w.call('board_import_answers', { path: join(folder, 'page.html') });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /Not an Alfred answers file/);
  } finally { await w.close(); }
});

test('board_image_put sends a picture and refuses a file that is not one', async () => {
  const w = await world();
  const folder = mkdtempSync(join(tmpdir(), 'alfred-img-'));
  try {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    let received: Buffer | null = null;
    w.fake.raw = (method, path, body, headers) => method === 'POST' && path === '/board/images'
      ? (received = body, { status: 201, headers: { 'Content-Type': 'application/json', 'X-Type': String(headers['content-type']) },
        body: JSON.stringify({ id: 'img-12345678', url: '/board/images/img-12345678' }) }) : undefined;
    writeFileSync(join(folder, 'shot.png'), png);
    const r = await w.call('board_image_put', { path: join(folder, 'shot.png'), name: 'the [badge]' });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json.markdown, '![the badge](/board/images/img-12345678)');
    assert.deepEqual(received, png);

    writeFileSync(join(folder, 'fake.png'), 'not a picture at all');
    const bad = await w.call('board_image_put', { path: join(folder, 'fake.png') });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /not a PNG, JPEG, GIF or WebP/);
    const b64 = await w.call('board_image_put', { base64: `data:image/png;base64,${png.toString('base64')}` });
    assert.equal(b64.isError, false, b64.text);
  } finally { await w.close(); }
});

test('board_ask carries a question\'s details into its questions block', async () => {
  const w = await world();
  try {
    await w.call('board_add', { project: 'p', kind: 'QUESTION', title: 'x' });
    const r = await w.call('board_ask', { project: 'p', number: 1, questions: [{ header: 'Viewed', question: 'Per user or per agency?',
      details: '![badge](/board/images/img-12345678)\n\n| user | new |\n|---|---|\n| mona | yes |', options: [{ label: 'Per user', recommended: true }, { label: 'Per agency' }] }] });
    assert.equal(r.isError, false, r.text);
    const comment = w.fake.requests('POST', '/comments').map((x) => (x.body as any).question as string).find((t) => t?.includes('```questions'));
    assert.ok(comment, 'a questions block was written');
    const block = JSON.parse(/```questions\n([\s\S]*?)\n```/.exec(comment!)![1]);
    assert.match(block.questions[0].details, /\/board\/images\/img-12345678/);
    assert.match(block.questions[0].details, /\| mona \| yes \|/);
  } finally { await w.close(); }
});
