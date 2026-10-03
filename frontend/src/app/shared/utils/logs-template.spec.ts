import { summaryOrFields, renderTemplate, templateTokens } from './logs-template';

describe('logs-template', () => {
  it('fills tokens and drops segments whose fields are all missing', () => {
    const t = '{methodName} · {message} · {externalService}';
    expect(renderTemplate(t, { methodName: 'performOperation', message: 'End external system call', externalService: 'Sabre' }))
      .toBe('performOperation · End external system call · Sabre');
    expect(renderTemplate(t, { methodName: 'loginV2', message: 'API request' })).toBe('loginV2 · API request');
    expect(renderTemplate('{a} took {ms} ms', { a: 'x', ms: 12 })).toBe('x took 12 ms');
    expect(renderTemplate('literal only', {})).toBe('literal only');
  });

  it('lists the labels a template reads', () => {
    expect(templateTokens('{a} · {b.c} and {a}')).toEqual(['a', 'b.c', 'a']);
  });

  it('falls back to the line own fields when it has none of the template fields (another structure)', () => {
    expect(summaryOrFields('{methodName} · {message}', { job: 'nightly', records: 10, severity: 'error' }, new Set(['severity'])))
      .toBe('job=nightly · records=10');
    expect(summaryOrFields('{message}', { message: 'hi', job: 'x' })).toBe('hi');
  });
});
