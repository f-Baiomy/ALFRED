import { emptyResultOf, softFailureOf } from './soft-failure';

const ok = (body: string, status = 200) => ({ response: { status, body } });

describe('softFailureOf', () => {
  it('finds an OTA error code and its text in a 200 (the Air Arabia 322 case)', () => {
    const body = '<soap:Envelope><soap:Body><OTA_AirAvailRS><Errors><Error Type="1" Code="322" ShortText="No availability">No availability for the requested route</Error></Errors></OTA_AirAvailRS></soap:Body></soap:Envelope>';
    expect(softFailureOf(ok(body))).toEqual({ kind: 'xml-error', code: '322', message: 'No availability' });
  });

  it('finds a SOAP Fault', () => {
    const body = '<s:Envelope><s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring>Invalid credentials</faultstring></s:Fault></s:Body></s:Envelope>';
    expect(softFailureOf(ok(body))).toEqual({ kind: 'soap-fault', code: 's:Client', message: 'Invalid credentials' });
  });

  it('finds JSON errors, success:false and an error object', () => {
    expect(softFailureOf(ok('{"errors":[{"code":"E12","message":"Fare expired"}]}'))).toEqual({ kind: 'json-errors', code: 'E12', message: 'Fare expired' });
    expect(softFailureOf(ok('{"success":false,"message":"Session timed out"}'))?.message).toBe('Session timed out');
    expect(softFailureOf(ok('{"data":null,"error":{"code":401,"message":"Token expired"}}'))).toEqual({ kind: 'json-error', code: '401', message: 'Token expired' });
    expect(softFailureOf(ok('{"result":{"errors":["timeout"]}}'))?.message).toBe('timeout');
  });

  it('ignores empty error holders, warnings, failed statuses and plain success', () => {
    expect(softFailureOf(ok('{"errors":[],"error":null,"offers":[1]}'))).toBeNull();
    expect(softFailureOf(ok('<RS><Warnings><Warning Code="1">x</Warning></Warnings><Success/></RS>'))).toBeNull();
    expect(softFailureOf(ok('{"errors":["x"]}', 500))).toBeNull();
    expect(softFailureOf({ response: { status: 200 }, error: 'Client disconnected.' })).toBeNull();
    expect(softFailureOf(ok('{"a":{"b":{"error":"deep data, not a failure"}}}'))).toBeNull();
  });
});

describe('emptyResultOf', () => {
  it('flags a search whose result lists are all empty', () => {
    const body = '{"searchOffers":{"segments":{},"journeys":{},"offers":{},"tripType":"OneWay"},"groupedOffers":{}}';
    expect(emptyResultOf(ok(body))?.emptyKeys).toEqual(['searchOffers.journeys', 'searchOffers.offers', 'groupedOffers']);
  });

  it('treats an object of empty buckets as empty (the real odeysys search)', () => {
    const body = '{"searchOffers":{"segments":{},"offers":{},"tripType":"OneWay"},"groupedOffers":{},'
      + '"bestPriceOffers":{"00:00-05:59":{},"06:00-11:59":{}},"context":{"projectName":"Wonder Travel"}}';
    expect(emptyResultOf(ok(body))?.emptyKeys).toEqual(['searchOffers.offers', 'groupedOffers', 'bestPriceOffers']);
    expect(emptyResultOf(ok('{"bestPriceOffers":{"00:00-05:59":{"id":1}}}'))).toBeNull();
  });

  it('counts a zero total', () => {
    expect(emptyResultOf(ok('{"total":0,"items":[]}'))?.emptyKeys).toEqual(['total', 'items']);
  });

  it('does not flag when any result list holds something, or when there are none', () => {
    expect(emptyResultOf(ok('{"offers":[],"results":[{"id":1}]}'))).toBeNull();
    expect(emptyResultOf(ok('{"name":"x"}'))).toBeNull();
    expect(emptyResultOf(ok('{"offers":[]}', 404))).toBeNull();
  });
});
