import { detectValue, explainValue } from './logs-value-format';

describe('logs-value-format', () => {
  it('finds JSON objects and arrays, and says what they hold', () => {
    const d = detectValue('{"pnr":{"supplier":"TravelportNdc"},"ok":true}')!;
    expect(d.kind).toBe('json');
    expect(d.summary).toBe('object with 2 keys');
    expect(d.pretty).toBe(JSON.stringify({ pnr: { supplier: 'TravelportNdc' }, ok: true }, null, 2));
    expect(detectValue('  [1,2,3] ')!.summary).toBe('array of 3');
  });

  it('unwraps JSON that was stored as a string inside quotes', () => {
    const d = detectValue(JSON.stringify(JSON.stringify({ status: 'OK', total: 2 })))!;
    expect(d.kind).toBe('json');
    expect(d.unwrapped).toBeTrue();
    expect(d.json).toEqual({ status: 'OK', total: 2 });
  });

  it('finds XML, naming its root element', () => {
    const d = detectValue('<soap:Envelope xmlns:soap="urn:s"><soap:Body><Ping>hi</Ping></soap:Body></soap:Envelope>')!;
    expect(d.kind).toBe('xml');
    expect(d.summary).toBe('root <soap:Envelope> · 3 elements');
    expect(d.pretty.split('\n').length).toBeGreaterThan(1);
  });

  it('finds nothing in plain text, scalars or broken values', () => {
    expect(detectValue('UnrecognizedPropertyException : Unrecognized field "error"')).toBeNull();
    expect(detectValue('42')).toBeNull();
    expect(detectValue('"just a string"')).toBeNull();
    expect(detectValue('{"a":1,"b":')).toBeNull();
    expect(detectValue('<a><b></a>')).toBeNull();
  });

  it('explains JSON cut off by a length limit: where it stops and the text before it', () => {
    const p = explainValue('{"pnr":{"name":{"first":"RA');
    expect(p.kind).toBe('json');
    expect(p.endsEarly).toBeTrue();
    expect(p.message).toContain('ends too early');
    expect(p.message).toContain('line 1');
    expect(p.before!.endsWith('"first":"RA')).toBeTrue();
  });

  it('explains JSON that breaks in the middle, pointing at the character', () => {
    const p = explainValue('{"a":1 "b":2}');
    expect(p.kind).toBe('json');
    expect(p.endsEarly).toBeFalse();
    expect(p.at).toBe('"');
  });

  it('explains broken XML with the parser\'s own message, and plain text as plain text', () => {
    const x = explainValue('<a><b>hello</c></a>');
    expect(x.kind).toBe('xml');
    expect(x.message).toContain('Looks like XML, but it does not parse');
    expect(explainValue('at com.ws.Foo.bar(Foo.java:12)').kind).toBe('text');
  });
});
