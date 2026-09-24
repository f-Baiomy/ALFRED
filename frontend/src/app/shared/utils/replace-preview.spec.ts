import { RuleAction } from '../../core/models/interception.model';
import { previewBodyReplace, pythonTemplateToJs } from './replace-preview';

const act = (a: Partial<RuleAction>): RuleAction => ({ type: 'REPLACE_IN_REQUEST_BODY', ...a });

describe('previewBodyReplace', () => {
  it('replaces literally and case-sensitively by default, everywhere', () => {
    expect(previewBodyReplace('EUR eur EUR', act({ pattern: 'EUR', replacement: 'USD' }))).toEqual({ text: 'USD eur USD', count: 2, reason: null });
  });

  it('keeps a literal replacement literal - no group references, no $ expansion', () => {
    expect(previewBodyReplace('a.b', act({ pattern: '.', replacement: '$1\\1' })).text).toBe('a$1\\1b');
  });

  it('folds case when asked, and stops at maxReplacements', () => {
    expect(previewBodyReplace('EUR eur EUR', act({ pattern: 'eur', replacement: 'X', caseSensitive: false, maxReplacements: 2 })).text).toBe('X X EUR');
  });

  it('uses a regex with Python-style groups', () => {
    const r = previewBodyReplace('<Currency>EUR</Currency>', act({ pattern: '<Currency>(\\w+)</Currency>', replacement: '<Currency>USD</Currency><!-- was \\1 -->', regex: true }));
    expect(r.text).toBe('<Currency>USD</Currency><!-- was EUR -->');
    expect(r.count).toBe(1);
  });

  it("says why nothing changed, in the proxy's words", () => {
    expect(previewBodyReplace('abc', act({ pattern: 'zzz', replacement: 'y' })).reason).toBe('no match');
    expect(previewBodyReplace('', act({ pattern: 'a' })).reason).toBe('empty body');
    expect(previewBodyReplace('abc', act({ pattern: '(', regex: true })).reason).toContain('invalid regex');
    expect(previewBodyReplace('abc', act({})).reason).toBe('no pattern');
  });

  it('translates Python templates', () => {
    expect(pythonTemplateToJs('\\1-\\g<2>-\\g<name>-$')).toBe('$1-$2-$<name>-$$');
  });
});
