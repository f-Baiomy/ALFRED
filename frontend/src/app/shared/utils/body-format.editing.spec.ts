import {
  LIVE_CHECK_LIMIT,
  bodiesDiffer,
  detectBodyKind,
  findMatches,
  formatBody,
  minifyBody,
  normalizeBody,
  validateBody,
} from './body-format';

const SOAP = '<soap:Envelope xmlns:soap="http://x"><soap:Body><Search><Origin>CAI</Origin></Search></soap:Body></soap:Envelope>';

describe('editing a body by hand', () => {
  describe('detectBodyKind', () => {
    it('tells JSON, XML and anything else apart', () => {
      expect(detectBodyKind('{"a":1}')).toBe('json');
      expect(detectBodyKind('[1,2]')).toBe('json');
      expect(detectBodyKind(SOAP)).toBe('xml');
      expect(detectBodyKind('grant_type=client_credentials&scope=read')).toBe('text');
      expect(detectBodyKind('')).toBe('text');
      expect(detectBodyKind(null)).toBe('text');
    });

    it('does not mistake an HTML error page for XML', () => {
      // tryParseXml goes through DOMParser rather than "starts with a <", which is what stops a
      // 502 page from a load balancer being coloured as a SOAP envelope.
      expect(detectBodyKind('<html><body>502 Bad Gateway<br>nginx</body></html>')).toBe('text');
    });
  });

  describe('formatBody', () => {
    it('pretty-prints JSON', () => {
      expect(formatBody('{"a":1,"b":[2]}', 'json')).toBe('{\n  "a": 1,\n  "b": [\n    2\n  ]\n}');
    });

    it('pretty-prints XML, including a SOAP envelope on one line', () => {
      const formatted = formatBody(SOAP, 'xml') ?? '';

      expect(formatted.split('\n').length).toBeGreaterThan(3);
      expect(formatted).toContain('  <soap:Body>');
    });

    it('refuses rather than mangling what it cannot parse', () => {
      // Null, not the input unchanged, so the caller can tell "nothing to do" from "done".
      expect(formatBody('{"a":', 'json')).toBeNull();
      expect(formatBody('<a><b></a>', 'xml')).toBeNull();
      expect(formatBody('grant_type=x', 'text')).toBeNull();
    });
  });

  describe('minifyBody', () => {
    it('strips the layout back out of both formats', () => {
      expect(minifyBody('{\n  "a": 1\n}', 'json')).toBe('{"a":1}');
      expect(minifyBody('<a>\n  <b>text</b>\n</a>', 'xml')).toBe('<a><b>text</b></a>');
    });

    it('leaves whitespace INSIDE an element alone, because that is content', () => {
      expect(minifyBody('<a><b>two  words</b></a>', 'xml')).toBe('<a><b>two  words</b></a>');
    });
  });

  describe('normalizeBody — what decides whether a paused call was edited', () => {
    it('treats reformatted JSON as unchanged', () => {
      // The load-bearing case. Releasing sends only what changed, so an untouched release stays
      // byte-identical to never having paused - pretty-printing must not quietly break that.
      expect(bodiesDiffer('{"a":1,"b":2}', '{\n  "a": 1,\n  "b": 2\n}')).toBeFalse();
    });

    it('treats reformatted XML as unchanged', () => {
      expect(bodiesDiffer(SOAP, formatBody(SOAP, 'xml'))).toBeFalse();
    });

    it('treats a changed value as changed, however it is laid out', () => {
      expect(bodiesDiffer('{"a":1}', '{\n  "a": 2\n}')).toBeTrue();
      expect(bodiesDiffer(SOAP, SOAP.replace('CAI', 'DXB'))).toBeTrue();
    });

    it('notices whitespace inside a JSON string, which is content', () => {
      expect(bodiesDiffer('{"a":"x"}', '{"a":"x "}')).toBeTrue();
    });

    it('compares plain text exactly, having nothing to normalise it with', () => {
      expect(bodiesDiffer('a=1&b=2', 'a=1&b=2')).toBeFalse();
      expect(bodiesDiffer('a=1&b=2', 'a=1&b=3')).toBeTrue();
      expect(bodiesDiffer('a=1', ' a=1')).toBeTrue();
    });

    it('is stable when applied twice', () => {
      const once = normalizeBody(SOAP, 'xml');
      expect(normalizeBody(once, 'xml')).toBe(once);
    });
  });

  describe('validateBody', () => {
    it('passes valid JSON and XML', () => {
      expect(validateBody('{"a":1}', 'json').state).toBe('valid');
      expect(validateBody(SOAP, 'xml').state).toBe('valid');
    });

    it('reports WHY invalid JSON is invalid, in the parser’s own words', () => {
      const result = validateBody('{"a":', 'json');

      expect(result.state).toBe('invalid');
      expect(result.message?.length).toBeGreaterThan(0);
    });

    it('reports malformed XML', () => {
      expect(validateBody('<a><b></a>', 'xml').state).toBe('invalid');
    });

    it('still judges a half-typed JSON edit as broken JSON, not as plain text', () => {
      // Otherwise the tick would vanish rather than turning into an error the moment you delete
      // a brace - which reads as "this is fine" at exactly the wrong moment.
      expect(validateBody('{"a": 1,', 'text').state).toBe('invalid');
    });

    it('says nothing about a body with no structure to check', () => {
      expect(validateBody('grant_type=x', 'text').state).toBe('none');
      expect(validateBody('   ', 'json').state).toBe('none');
    });

    it('skips the check on a body too large to parse per keystroke', () => {
      // A 6 MB payload is real here; parsing it per character would make the textarea unusable,
      // which is a worse failure than not showing a tick.
      const huge = '{"a":"' + 'x'.repeat(LIVE_CHECK_LIMIT) + '"}';

      expect(validateBody(huge, 'json').state).toBe('unchecked');
    });
  });

  describe('findMatches', () => {
    it('finds every occurrence, case-insensitively', () => {
      expect(findMatches('seatsRemaining and SeatsRemaining', 'seatsremaining')).toEqual([0, 19]);
    });

    it('finds nothing for an empty query rather than everything', () => {
      expect(findMatches('anything', '')).toEqual([]);
    });

    it('does not overlap matches with themselves', () => {
      expect(findMatches('aaaa', 'aa')).toEqual([0, 2]);
    });
  });
});
