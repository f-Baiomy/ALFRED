import { commentsInside, jsonLines } from './logs-json-lines';

describe('logs-json-lines', () => {
  const line = {
    '@timestamp': '2026-10-01T23:55:57.72Z',
    message: { correlationId: 'c1', context: { timeTaken: 30000, ok: false, none: null } },
    fields: { VM_name: ['portal-24'], list: [1, 2] },
  };

  it('gives every value line the flattened field path the backend uses', () => {
    const paths = jsonLines(line, new Set()).map((l) => l.path).filter((p): p is string => !!p);
    expect(paths).toContain('message.context.timeTaken');
    expect(paths).toContain('fields.VM_name'); // a one-element array shares its parent's path
    expect(paths).toContain('fields.list.0');
    const timeTaken = jsonLines(line, new Set()).find((l) => l.path === 'message.context.timeTaken')!;
    expect(timeTaken.tokens.map((t) => t.text).join('')).toBe('"timeTaken": 30000,');
  });

  it('folds a block into one summary line', () => {
    const open = jsonLines(line, new Set()).find((l) => l.path === 'message.context' && l.foldKey)!;
    const folded = jsonLines(line, new Set([open.foldKey!]));
    const summary = folded.find((l) => l.foldKey === open.foldKey)!;
    expect(summary.folded).toBeTrue();
    expect(summary.tokens.map((t) => t.text).join('')).toContain('{ … 3 fields }');
    expect(folded.some((l) => l.path === 'message.context.timeTaken')).toBeFalse();
    expect(commentsInside('message.context', ['message.context.timeTaken', 'message.correlationId'])).toBe(1);
  });

  it('never shortens a long value', () => {
    const big = 'x'.repeat(5_000_000);
    const l = jsonLines({ body: big }, new Set()).find((x) => x.path === 'body')!;
    expect(l.tokens.find((t) => t.cls === 's')!.text.length).toBe(big.length + 2);
  });
});
