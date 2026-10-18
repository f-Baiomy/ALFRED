import assert from 'node:assert/strict';
import { createServer as createHttp, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { AlfredClient } from '../src/alfred-client.ts';

/** A one-route server that remembers the headers of each request. */
async function recorder(): Promise<{ url: string; seen: IncomingHttpHeaders[]; close: () => Promise<void> }> {
  const seen: IncomingHttpHeaders[] = [];
  const server = createHttp((req, res) => {
    seen.push(req.headers);
    if (req.url?.startsWith('/board/held')) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'HELD', message: 'This board is held by me@x.ae on WORK-PC.' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, seen, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

test('the client names the user and session with every request (specs/031 board lock)', async () => {
  const r = await recorder();
  try {
    await new AlfredClient(r.url, { key: 'ak_0123456789abcdef.s', via: 'cli-1' }).get('/board/cards');
    assert.equal(r.seen[0]?.['x-alfred-key'], 'ak_0123456789abcdef.s');
    assert.equal(r.seen[0]?.['x-alfred-via'], 'cli-1');

    await new AlfredClient(r.url, { key: '', via: '' }).get('/board/cards');
    assert.equal(r.seen[1]?.['x-alfred-key'], undefined);
  } finally { await r.close(); }
});

test('a write on a board someone else holds says who holds it', async () => {
  const r = await recorder();
  try {
    await assert.rejects(new AlfredClient(r.url, { key: '', via: '' }).post('/board/held', { body: {} }),
      (e: Error & { code?: string }) => e.code === 'HELD' && /held by me@x\.ae/.test(e.message));
  } finally { await r.close(); }
});
