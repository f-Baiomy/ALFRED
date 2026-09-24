import { headersToJsonText, parseHeaderRows, rowsFromHeadersJson, serializeHeaderRows } from './header-rows';

describe('header-rows', () => {
  it('serializes the full row list, removed rows included, and parses it back', () => {
    const rows = [
      { name: 'a', value: '1', removed: false },
      { name: 'b', value: '2', removed: true, added: false },
      { name: 'c', value: '3', removed: false, added: true },
    ];

    const text = serializeHeaderRows(rows);

    expect(JSON.parse(text)).toEqual([
      { name: 'a', value: '1', removed: false, added: false },
      { name: 'b', value: '2', removed: true, added: false },
      { name: 'c', value: '3', removed: false, added: true },
    ]);
    expect(parseHeaderRows(text)).toEqual(JSON.parse(text));
  });

  it('refuses anything that is not the row list', () => {
    expect(parseHeaderRows('{"a":"1"}')).toBeNull();
    expect(parseHeaderRows('[{"name":"a"}]')).toBeNull();
    expect(parseHeaderRows('nope')).toBeNull();
    expect(parseHeaderRows('')).toBeNull();
  });

  it('leaves removed and blank-named rows out of the editable object', () => {
    expect(
      headersToJsonText([
        { name: 'a', value: '1', removed: false },
        { name: 'b', value: '2', removed: true },
        { name: ' ', value: 'x', removed: false, added: true },
      ])
    ).toBe('{\n  "a": "1"\n}');
  });

  it('un-removes a struck-through header that reappears, and accepts numbers as text', () => {
    const result = rowsFromHeadersJson('{"b": 2}', [{ name: 'b', value: '1', removed: true }]);

    expect(result).toEqual({ ok: true, rows: [{ name: 'b', value: '2', removed: false, added: false }] });
  });
});
