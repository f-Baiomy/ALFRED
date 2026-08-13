import { CallRecord } from '../../core/models/call.model';
import { ExportFormData } from '../../core/models/export-metadata.model';
import { PostmanCollection, buildBulkPostmanCollection, bulkPostmanFilename } from './postman-builder';

function makeCall(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    id: 'call-1',
    original_url: 'https://example.com-proxy/api/x',
    url: 'https://example.com/api/x',
    method: 'POST',
    request: { headers: { 'Content-Type': 'application/json' }, body: '{"a":1}' },
    timestamp: '2026-08-07T13:45:51.965328+00:00',
    duration_ms: 100,
    response: { status: 200, headers: { 'X-Trace': 'abc' }, body: '{"ok":true}' },
    ...overrides,
  };
}

function makeForm(overrides: Partial<ExportFormData> = {}): ExportFormData {
  return {
    supplierName: 'FlyNas',
    credentialsUsed: 'EGY',
    apiKey: 'secret-key',
    url: 'https://example.com/api/x',
    environment: 'Staging',
    description: '',
    ...overrides,
  };
}

describe('buildBulkPostmanCollection', () => {
  it('is a valid v2.1 collection shape with one item per call', () => {
    const collection: PostmanCollection = buildBulkPostmanCollection([makeCall()], makeForm(), '2026-08-07T18:00:00Z');

    expect(collection.info.schema).toBe('https://schema.getpostman.com/json/collection/v2.1.0/collection.json');
    expect(collection.info.name).toContain('FlyNas');
    expect(collection.info.name).toContain('1 call');
    expect(collection.item.length).toBe(1);
  });

  it('carries method, headers, and body onto the request', () => {
    const collection = buildBulkPostmanCollection([makeCall()], makeForm(), '2026-08-07T18:00:00Z');
    const request = collection.item[0].request;

    expect(request.method).toBe('POST');
    expect(request.url).toBe('https://example.com/api/x');
    expect(request.header).toEqual([{ key: 'Content-Type', value: 'application/json' }]);
    expect(request.body).toEqual({ mode: 'raw', raw: '{"a":1}', options: { raw: { language: 'json' } } });
  });

  it('omits the body entirely when the request had none', () => {
    const call = makeCall({ request: { headers: {}, body: undefined } });
    const collection = buildBulkPostmanCollection([call], makeForm(), '2026-08-07T18:00:00Z');

    expect(collection.item[0].request.body).toBeUndefined();
  });

  it('attaches the recorded response as a saved example', () => {
    const collection = buildBulkPostmanCollection([makeCall()], makeForm(), '2026-08-07T18:00:00Z');
    const response = collection.item[0].response[0];

    expect(response.code).toBe(200);
    expect(response.status).toBe('OK');
    expect(response.header).toEqual([{ key: 'X-Trace', value: 'abc' }]);
    expect(response.body).toBe('{"ok":true}');
    expect(response.originalRequest).toBe(collection.item[0].request);
  });

  it('has no response examples when the call never got one', () => {
    const call = makeCall({ response: undefined, error: 'timeout' });
    const collection = buildBulkPostmanCollection([call], makeForm(), '2026-08-07T18:00:00Z');

    expect(collection.item[0].response).toEqual([]);
  });

  it('prefixes the item name with the supplier and never truncates a large body', () => {
    const bigArray = Array.from({ length: 200 }, (_, i) => ({ index: i }));
    const call = makeCall({ supplierName: 'Galileo', response: { status: 200, headers: {}, body: JSON.stringify(bigArray) } });
    const collection = buildBulkPostmanCollection([call], makeForm(), '2026-08-07T18:00:00Z');

    expect(collection.item[0].name).toContain('[Galileo]');
    expect(JSON.parse(collection.item[0].response[0].body).length).toBe(200);
  });
});

describe('bulkPostmanFilename', () => {
  it('names the file after the call count', () => {
    expect(bulkPostmanFilename([makeCall(), makeCall({ id: 'call-2' })])).toBe('alfred-export-2-calls.postman_collection.json');
  });
});
