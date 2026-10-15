import { MentionRef } from '../../core/models/board.models';
import { MAX_CHIPS, callChip, cardChip, chatScopeFor, logChip, statementChip, withChip, withoutChip } from './chat-context';

describe('chat-context', () => {
  it('asks in the cycle chat when the item is in a cycle, else in the project chat', () => {
    expect(chatScopeFor('c-1')).toBe('c-1');
    expect(chatScopeFor(null)).toBe('project');
    expect(chatScopeFor(undefined)).toBe('project');
    expect(chatScopeFor('')).toBe('project');
  });

  it('writes a call as "Add to board" does, with its cycle', () => {
    const call = { id: 'a1', source: 'internal', method: 'POST', url: 'http://localhost:8080/api/search?x=1', response: { status: 500 } };
    expect(callChip(call, 'c-1')).toEqual({ type: 'call', ref: 'in:a1@c-1', label: 'POST /api/search · 500' });
    expect(callChip({ ...call, source: 'external', response: null, error: 'reset' }, null))
      .toEqual({ type: 'call', ref: 'out:a1', label: 'POST /api/search · error' });
    expect(callChip({ id: 'b', method: 'GET', url: '/plain/path' }, null).label).toBe('GET /plain/path · …');
  });

  it('writes statements, log lines and cards as the mention picker does', () => {
    expect(statementChip('a1', 7, 'SELECT', 'orders')).toEqual({ type: 'stmt', ref: 'a1/7', label: 'SELECT orders #7' });
    expect(statementChip('a1', 7, 'COMMIT', null).label).toBe('COMMIT #7');
    expect(logChip('a1', 'L9', 'ERROR', 'com.x.OrderService')).toEqual({ type: 'log', ref: 'a1/L9', label: 'ERROR OrderService' });
    expect(logChip('a1', 3, null, null).label).toBe('log line');
    expect(cardChip('odeysys', 12, 'x'.repeat(80)).label).toHaveSize(60);
    expect(cardChip('odeysys', 12, 'Search').ref).toBe('odeysys#12');
  });

  it('keeps each chip once, newest last, at most ten', () => {
    const chip = (i: number): MentionRef => ({ type: 'call', ref: `in:${i}`, label: `#${i}` });
    let list: MentionRef[] = [];
    for (let i = 0; i < 12; i++) list = withChip(list, chip(i));
    expect(list).toHaveSize(MAX_CHIPS);
    expect(list[0].ref).toBe('in:2');
    list = withChip(list, chip(5));
    expect(list.at(-1)!.ref).toBe('in:5');
    expect(list.filter((c) => c.ref === 'in:5')).toHaveSize(1);
    expect(withoutChip(list, chip(5)).some((c) => c.ref === 'in:5')).toBeFalse();
  });
});
