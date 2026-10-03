import { soapSummary } from './soap-summary';

describe('soapSummary', () => {
  const env11 = (body: string) =>
    `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>${body}</soap:Body></soap:Envelope>`;
  const env12 = (body: string) =>
    `<env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope"><env:Header/><env:Body>${body}</env:Body></env:Envelope>`;

  it('names the version and the operation - the first element inside the Body', () => {
    expect(soapSummary(env11('<Add xmlns="http://tempuri.org/"><intA>7</intA></Add>')))
      .toEqual({ version: '1.1', operation: 'Add', isFault: false, faultCode: null, faultReason: null });
    expect(soapSummary(env12('<m:GetPrice xmlns:m="urn:x"/>'))?.operation).toBe('GetPrice');
    expect(soapSummary(env12('<m:GetPrice xmlns:m="urn:x"/>'))?.version).toBe('1.2');
  });

  it('reads a SOAP 1.1 fault code and reason', () => {
    const summary = soapSummary(env11('<soap:Fault><faultcode>soap:Client</faultcode><faultstring>Bad intA</faultstring></soap:Fault>'));
    expect(summary).toEqual({ version: '1.1', operation: null, isFault: true, faultCode: 'soap:Client', faultReason: 'Bad intA' });
  });

  it('reads a SOAP 1.2 fault code and reason', () => {
    const summary = soapSummary(env12(
      '<env:Fault><env:Code><env:Value>env:Receiver</env:Value></env:Code><env:Reason><env:Text xml:lang="en">Down</env:Text></env:Reason></env:Fault>',
    ));
    expect(summary?.isFault).toBeTrue();
    expect(summary?.faultCode).toBe('env:Receiver');
    expect(summary?.faultReason).toBe('Down');
  });

  it('is null for plain XML, an Envelope in the wrong namespace, and anything that does not parse', () => {
    expect(soapSummary('<a><b>1</b></a>')).toBeNull();
    expect(soapSummary('<Envelope xmlns="urn:not-soap"><Body/></Envelope>')).toBeNull();
    expect(soapSummary('{"a":1}')).toBeNull();
    expect(soapSummary('<a>')).toBeNull();
    expect(soapSummary(undefined)).toBeNull();
  });

  it('has no operation for an empty Body', () => {
    expect(soapSummary(env11(''))?.operation).toBeNull();
  });
});
