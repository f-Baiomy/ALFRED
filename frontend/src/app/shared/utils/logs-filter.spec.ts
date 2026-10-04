import { Pill } from '../../core/models/logs.model';
import { formToPill, parseQueryText, pillToForm, pillWords, toQueryText } from './logs-filter';

describe('logs-filter', () => {
  const fields = new Set(['level', 'message', 'message.methodName', 'timeTaken', 'first name']);

  it('turns the form into the pill the query sends, and back', () => {
    const cases: [Parameters<typeof formToPill>[0], Pill][] = [
      [{ include: true, field: 'level', condition: 'is', values: ['ERROR'], value: '' }, { op: 'EQ', field: 'level', value: 'ERROR', or: null, off: null }],
      [{ include: false, field: 'level', condition: 'is', values: ['ERROR', 'WARN'], value: '' }, { op: 'NEQ', field: 'level', values: ['ERROR', 'WARN'], or: null, off: null }],
      [{ include: true, field: 'message', condition: 'contains', values: [], value: 'timeout' }, { op: 'CONTAINS', field: 'message', value: 'timeout', not: null, or: null, off: null }],
      [{ include: false, field: 'timeTaken', condition: 'gt', values: [], value: '6000' }, { op: 'GT', field: 'timeTaken', value: '6000', not: true, or: null, off: null }],
      [{ include: false, field: 'level', condition: 'exists', values: [], value: '' }, { op: 'NOT_EXISTS', field: 'level', or: null, off: null }],
      [{ include: true, field: '', condition: 'contains', values: [], value: 'anotrav' }, { op: 'TEXT', value: 'anotrav', not: null, or: null, off: null }],
    ];
    for (const [form, pill] of cases) {
      expect(formToPill(form)).toEqual(pill);
      expect(pillToForm(pill)).toEqual(form);
    }
    // Editing keeps the pill's OR join and on/off state; an unfinished form is no pill.
    expect(formToPill({ include: true, field: 'level', condition: 'is', values: ['INFO'], value: '' }, { op: 'EQ', field: 'level', value: 'ERROR', or: true, off: true }))
      .toEqual({ op: 'EQ', field: 'level', value: 'INFO', or: true, off: true });
    expect(formToPill({ include: true, field: 'level', condition: 'is', values: [], value: '' })).toBeNull();
    expect(formToPill({ include: true, field: '', condition: 'gt', values: [], value: '5' })).toBeNull();
  });

  it('words a pill: NOT, field, condition, value', () => {
    expect(pillWords({ op: 'NEQ', field: 'level', value: 'ERROR' })).toEqual({ not: true, field: 'level', word: 'is', value: 'ERROR' });
    expect(pillWords({ op: 'EQ', field: 'level', values: ['ERROR', 'WARN'] })).toEqual({ not: false, field: 'level', word: 'is any of', value: 'ERROR, WARN' });
    expect(pillWords({ op: 'GT', field: 'timeTaken', value: '6000', not: true })!.not).toBeTrue();
    expect(pillWords({ op: 'SELECTION', lineIds: ['a'] })).toBeNull();
  });

  it('writes the whole search as one line and reads it back unchanged', () => {
    const pills: Pill[] = [
      { op: 'EQ', field: 'message', value: 'API request' },
      { op: 'EQ', field: 'level', values: ['ERROR', 'WARN'], or: true },
      { op: 'GT', field: 'timeTaken', value: '6000', not: true },
      { op: 'CONTAINS', field: 'message.methodName', value: 'fare' },
      { op: 'EXISTS', field: 'first name' },
      { op: 'TEXT', value: 'say "hi"' },
      { op: 'NEQ', field: 'level', value: 'DEBUG', off: true },
    ];
    const text = toQueryText(pills, { from: Date.UTC(2026, 9, 4, 9), to: null });
    expect(text).toBe('message:"API request" OR level:ERROR|WARN -timeTaken>6000 message.methodName~fare "first name":* "say \\"hi\\"" @2026-10-04T09:00:00.000Z..now');
    const back = parseQueryText(text, fields);
    expect(back.range).toEqual({ from: Date.UTC(2026, 9, 4, 9), to: null });
    expect(back.pills).toEqual([
      { op: 'EQ', field: 'message', value: 'API request' },
      { op: 'EQ', field: 'level', values: ['ERROR', 'WARN'], or: true },
      { op: 'GT', field: 'timeTaken', value: '6000', not: true },
      { op: 'CONTAINS', field: 'message.methodName', value: 'fare', not: null },
      { op: 'EXISTS', field: 'first name' },
      { op: 'TEXT', value: 'say "hi"', not: null },
    ]);
    expect(parseQueryText('level:ERROR @last:24h', fields).range).toEqual({ preset: '24h' });
  });

  it('says what is wrong with a search it cannot read', () => {
    expect(() => parseQueryText('nope:1', fields)).toThrowError(/Unknown field/);
    expect(() => parseQueryText('OR level:ERROR', fields)).toThrowError(/before it/);
    expect(() => parseQueryText('level:"ERROR', fields)).toThrowError(/quote/);
    expect(() => parseQueryText('level:ERROR @yesterday', fields)).toThrowError(/time range/);
  });
});
