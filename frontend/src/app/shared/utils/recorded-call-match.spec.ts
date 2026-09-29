import { isGeneratedRequestHeader, recordedCallPreviewOf } from './recorded-call-match';

describe('recordedCallPreviewOf', () => {
  it('keeps the URL, method, and headers the application set', () => {
    const preview = recordedCallPreviewOf({
      method: 'post',
      url: 'https://ndc.example/api/FlightSearch/Search',
      requestHeaders: {
        Host: 'ndc.example',
        'Content-Length': '20',
        'Content-Type': 'application/json',
        'X-Request-Id': 'generated',
        CorrelationId: 'changes-every-call',
        'Client-Id': 'NDC-Core',
        SOAPAction: 'search',
      },
      requestBody: '{\n  "a": 1\n}',
    });
    expect(preview?.method).toBe('POST');
    expect(preview?.url).toBe('https://ndc.example/api/FlightSearch/Search');
    expect(preview?.headerNames).toEqual(['Client-Id', 'Content-Type', 'SOAPAction']);
    expect(preview?.bodyNote).toContain('JSON');
  });

  it('describes a SOAP body separately from JSON', () => {
    const preview = recordedCallPreviewOf({
      method: 'POST',
      url: 'https://supplier.example/soap',
      requestHeaders: {},
      requestBody: '<soap:Envelope></soap:Envelope>',
    });
    expect(preview?.bodyNote).toContain('SOAP');
    expect(preview?.headerNames).toEqual([]);
  });

  it('treats trace headers as generated', () => {
    expect(isGeneratedRequestHeader('traceparent')).toBeTrue();
    expect(isGeneratedRequestHeader('X-B3-TraceId')).toBeTrue();
    expect(isGeneratedRequestHeader('CorrelationId')).toBeTrue();
    expect(isGeneratedRequestHeader('Content-Type')).toBeFalse();
    expect(isGeneratedRequestHeader('Client-Id')).toBeFalse();
  });
});
