import { parseDatasetText } from './resend-draft-dataset';

describe('parseDatasetText', () => {
  it('parses CSV with a header row', () => {
    const parsed = parseDatasetText('id,name\n1,Alice\n2,Bob');
    expect(parsed.error).toBeNull();
    expect(parsed.rows).toEqual([
      { id: '1', name: 'Alice' },
      { id: '2', name: 'Bob' },
    ]);
  });

  it('handles quoted fields with embedded commas and escaped quotes', () => {
    const parsed = parseDatasetText('id,note\n1,"hello, ""world"""');
    expect(parsed.rows).toEqual([{ id: '1', note: 'hello, "world"' }]);
  });

  it('parses a JSON array of flat objects, stringifying non-string values', () => {
    const parsed = parseDatasetText('[{"id":1,"active":true},{"id":2,"active":false}]');
    expect(parsed.error).toBeNull();
    expect(parsed.rows).toEqual([
      { id: '1', active: 'true' },
      { id: '2', active: 'false' },
    ]);
  });

  it('reports an error for malformed JSON that looks like an array', () => {
    const parsed = parseDatasetText('[{"id":]');
    expect(parsed.error).toBeTruthy();
    expect(parsed.rows).toEqual([]);
  });

  it('reports an error for a JSON value that is not an array', () => {
    const parsed = parseDatasetText('{"id":1}');
    expect(parsed.error).toBe('Expected a JSON array of objects.');
  });

  it('treats empty text as zero rows without an error', () => {
    expect(parseDatasetText('   ')).toEqual({ rows: [], error: null });
  });
});
