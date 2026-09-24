import { CallRecord } from '../../core/models/call.model';
import { CallInterception } from '../../core/models/interception.model';
import { buildBulkExportPayload } from './bulk-json-builder';
import { parseImportedCalls } from './import-parser';

/**
 * Every fixture here is produced by buildBulkExportPayload and then round-tripped through JSON,
 * never hand-written. That is the entire point of this file: the importer's previous tests asserted
 * against a hand-written `{ calls: [...] }` shape that no Alfred export has ever produced, so they
 * all passed while the feature could not read a single real export.
 */
const T0 = Date.parse('2026-01-01T00:00:00.000Z');

function call(overrides: Partial<CallRecord> & { id: string; startMs: number; durationMs: number }): CallRecord {
  const { id, startMs, durationMs, ...rest } = overrides;
  return {
    id,
    original_url: `http://localhost:9001/${id}`,
    url: `http://host.docker.internal:8080/${id}`,
    method: 'POST',
    request: { headers: { 'Content-Type': 'application/json' }, body: `{"q":"${id}"}` },
    timestamp: new Date(T0 + startMs).toISOString(),
    duration_ms: durationMs,
    response: { status: 200, headers: {}, body: `{"ok":"${id}"}` },
    state: 'COMPLETED',
    ...rest,
  };
}

/** An inbound call wrapping an outbound one - so the export splits the parent into two events and
 * emits the child whole, which is exactly the mix that used to come back corrupted. */
function nestedFixture(): CallRecord[] {
  return [
    call({ id: 'parent', startMs: 0, durationMs: 8000, source: 'internal', service_name: 'odeysys', session_id: 'sess-1', operation_id: 'op-1' }),
    call({ id: 'child', startMs: 1000, durationMs: 4000, source: 'external', service_name: null }),
  ];
}

const FORM = { supplierName: '', credentialsUsed: '', apiKey: '', url: '', environment: 'Staging', description: '' };

/** Exports for real, serializes, and reads it back the way the dialog does. */
function roundTrip(calls: readonly CallRecord[]) {
  const overlaps = calls.map((c) => ({
    id: c.id,
    timestamp: c.timestamp,
    durationMs: c.duration_ms ?? 0,
    source: c.source ?? 'external',
    serviceName: c.service_name ?? null,
    status: c.response?.status,
    error: c.error,
  }));
  const payload = buildBulkExportPayload(calls, FORM as never, new Map(), new Date().toISOString(), overlaps as never);
  return { payload, result: parseImportedCalls(JSON.parse(JSON.stringify(payload))) };
}

describe('parseImportedCalls', () => {
  it('reads a real export back - the shape the old importer could not see at all', () => {
    const { payload, result } = roundTrip(nestedFixture());

    // Guards the actual defect: the file has `events`, not `calls`, and keys them by `callId`.
    expect(Object.keys(payload)).toContain('events');
    expect(Object.keys(payload)).not.toContain('calls');
    expect(result.calls.length).toBe(2);
    expect(result.skippedCount).toBe(0);
  });

  it('merges a split call back into one record, keeping BOTH halves', () => {
    const { payload, result } = roundTrip(nestedFixture());

    // The parent really was exported as two events - otherwise this test proves nothing.
    expect(payload.events.filter((e) => e.callId === 'parent').length).toBe(2);

    const parent = result.calls.find((c) => c.id === 'parent')!;
    // From the request half...
    expect(parent.url).toBe('http://host.docker.internal:8080/parent');
    expect(parent.method).toBe('POST');
    expect(parent.request?.body).toBe('{"q":"parent"}');
    // ...and from the response half, which carries no url/method and used to be dropped entirely.
    expect(parent.response?.status).toBe(200);
    expect(parent.response?.body).toBe('{"ok":"parent"}');
    expect(parent.duration_ms).toBe(8000);
  });

  it('dates a split call at its REQUEST, not its response', () => {
    const { result } = roundTrip(nestedFixture());

    // The response event's timestamp is start+duration, and events are file-ordered by timestamp,
    // so a naive merge would date the parent 8s late and destroy the containment that nests the child.
    expect(result.calls.find((c) => c.id === 'parent')!.timestamp).toBe(new Date(T0).toISOString());
  });

  it('preserves direction, which decides which store a call is re-imported into', () => {
    const { result } = roundTrip(nestedFixture());

    expect(result.calls.find((c) => c.id === 'parent')!.source).toBe('internal');
    expect(result.calls.find((c) => c.id === 'child')!.source).toBe('external');
    expect(result.inferredDirectionCount).toBe(0);
  });

  it('preserves service and correlation ids', () => {
    const { result } = roundTrip(nestedFixture());
    const parent = result.calls.find((c) => c.id === 'parent')!;

    expect(parent.service_name).toBe('odeysys');
    expect(parent.session_id).toBe('sess-1');
    expect(parent.operation_id).toBe('op-1');
  });

  it('round-trips an OUTBOUND call that carries a service name, which inference would misfile', () => {
    // Forward-proxy outbound attribution: external, but with a service_name. This is the case that
    // makes "service_name means inbound" unsafe, so the export states `source` outright.
    const attributed = [call({ id: 'attributed', startMs: 0, durationMs: 100, source: 'external', service_name: 'odeysys' })];
    const { result } = roundTrip(attributed);

    expect(result.calls[0].source).toBe('external');
    expect(result.calls[0].service_name).toBe('odeysys');
    expect(result.inferredDirectionCount).toBe(0);
  });

  it('keeps an in-progress internal call, which exports as a request event with no response', () => {
    const inFlight = [
      call({ id: 'pending', startMs: 0, durationMs: 0, source: 'internal', service_name: 'odeysys', state: 'IN_PROGRESS', response: undefined }),
    ];
    const { result } = roundTrip(inFlight);

    expect(result.calls.length).toBe(1);
    expect(result.calls[0].response).toBeUndefined();
    expect(result.calls[0].state).toBe('IN_PROGRESS');
  });

  describe('older files, exported before direction was recorded', () => {
    /** Strips `source` from every event, reproducing a file exported before this fix. */
    function withoutSource(calls: readonly CallRecord[]) {
      const { payload } = roundTrip(calls);
      const events = payload.events.map((e) => {
        const copy = { ...e } as Record<string, unknown>;
        delete copy['source'];
        return copy;
      });
      return parseImportedCalls({ ...payload, events });
    }

    it('still imports them, inferring direction and reporting how many it guessed', () => {
      const result = withoutSource(nestedFixture());

      expect(result.calls.length).toBe(2);
      expect(result.calls.find((c) => c.id === 'parent')!.source).toBe('internal');
      expect(result.calls.find((c) => c.id === 'child')!.source).toBe('external');
      expect(result.inferredDirectionCount).toBe(2);
    });

    it('gets an attributed outbound call WRONG - which is why the count is surfaced, not swallowed', () => {
      const result = withoutSource([call({ id: 'attributed', startMs: 0, durationMs: 100, source: 'external', service_name: 'odeysys' })]);

      // Documenting the known limit of the fallback rather than pretending it is lossless.
      expect(result.calls[0].source).toBe('internal');
      expect(result.inferredDirectionCount).toBe(1);
    });
  });

  /**
   * The .json export is both the agent-facing document AND the re-import format, so the two can
   * pull in opposite directions: `about` exists to be read, `events` exists to be parsed back. These
   * pin the boundary - the importer must never come to depend on `about`, so narrative wording can
   * be improved freely without anyone having to re-test importing.
   */
  describe('the importer ignores about/metadata/summary entirely', () => {
    it('imports identically with the whole narrative stripped out', () => {
      const { payload, result } = roundTrip(nestedFixture());
      const stripped = parseImportedCalls({ events: payload.events });

      expect(stripped.calls).toEqual(result.calls as CallRecord[]);
      expect(stripped.inferredDirectionCount).toBe(0);
      expect(stripped.skippedCount).toBe(0);
    });

    it('imports identically when the reading guide changes', () => {
      const { payload, result } = roundTrip(nestedFixture());
      const reworded = {
        ...payload,
        about: { ...payload.about, readingGuide: { topology: 'x', events: 'y', nesting: 'z', comments: 'w' } },
      };

      expect(parseImportedCalls(reworded).calls).toEqual(result.calls as CallRecord[]);
    });

    it('still names about.topology as the structural entry point', () => {
      // Guards the actual point of the guide: an agent told to iterate `events` sees two half-calls
      // for every split call, which is the same mistake the old importer made.
      const { payload } = roundTrip(nestedFixture());
      const guide = payload.about.readingGuide;

      expect(guide.topology).toContain('about.topology');
      expect(guide.events).toContain('callId');
      expect(payload.about.topology.length).toBe(1);
      expect(payload.about.topology[0].children.length).toBe(1);
      // topology counts CALLS; events counts request/response halves - they must not be confused.
      expect(payload.about.counts.calls).toBe(2);
      expect(payload.events.length).toBe(3);
    });
  });

  describe('a redacted export announces itself', () => {
    it('reports the count the exporter declared, so the dialog can warn before importing', () => {
      const { payload } = roundTrip(nestedFixture());
      const redacted = { ...payload, redactedValueCount: 7 };

      const result = parseImportedCalls(JSON.parse(JSON.stringify(redacted)));

      // The calls still import - a redacted file is usable, just lossy, and saying so is the point.
      expect(result.calls.length).toBe(2);
      expect(result.redactedValueCount).toBe(7);
    });

    it('reports 0 for a normal export, so the warning never fires on a complete capture', () => {
      const { payload, result } = roundTrip(nestedFixture());

      expect(payload.redactedValueCount).toBe(0);
      expect(result.redactedValueCount).toBe(0);
    });

    it('treats a file with no marker at all as unredacted', () => {
      const result = parseImportedCalls({ events: [{ type: 'call', callId: 'a', url: 'http://x/a', source: 'external' }] });

      expect(result.redactedValueCount).toBe(0);
    });
  });

  describe('other shapes', () => {
    it('still accepts a bare array of call-shaped objects', () => {
      const result = parseImportedCalls([{ id: 'a', url: 'http://x/a', method: 'GET', source: 'external' }]);

      expect(result.calls.map((c) => c.id)).toEqual(['a']);
    });

    it('still accepts { calls: [...] }', () => {
      const result = parseImportedCalls({ calls: [{ id: 'a', url: 'http://x/a', source: 'external' }] });

      expect(result.calls.map((c) => c.id)).toEqual(['a']);
    });

    it('returns nothing for a file that is not an export', () => {
      expect(parseImportedCalls({ hello: 'world' }).calls.length).toBe(0);
      expect(parseImportedCalls(null).calls.length).toBe(0);
      expect(parseImportedCalls(42).calls.length).toBe(0);
    });

    it('skips unusable entries rather than failing the whole import', () => {
      const result = parseImportedCalls({ events: [{ type: 'call', callId: 'ok', url: 'http://x/a', source: 'external' }, null, { type: 'call' }] });

      expect(result.calls.map((c) => c.id)).toEqual(['ok']);
      expect(result.skippedCount).toBe(2);
    });

    it('skips a response half whose request is not in the file, instead of inventing a urlless call', () => {
      const result = parseImportedCalls({ events: [{ type: 'response', callId: 'orphan', status: 200, duration_ms: 5 }] });

      expect(result.calls.length).toBe(0);
      expect(result.skippedCount).toBe(1);
    });
  });
});

/** A realistic record: a rule rewrote the response, one action found nothing to do, and the
 * before/after bodies are large enough that any truncation would show. */
function interceptedRecord(): CallInterception {
  const bigBefore = '{"segments":[' + Array.from({ length: 4000 }, (_, i) => `{"n":${i},"cabin":"Y"}`).join(',') + ']}';
  const bigAfter = bigBefore.replace(/"Y"/g, '"J"');
  return {
    applied: [
      { ruleId: 'r1', ruleName: 'Upgrade cabins', action: 'SET_RESPONSE_JSON_FIELD', detail: 'segments[*].cabin' },
      { ruleId: 'r1', ruleName: 'Upgrade cabins', action: 'REMOVE_RESPONSE_HEADER', detail: 'skipped - no such header' },
    ],
    originalResponse: { status: 200, reason: 'OK', headers: { 'content-type': 'application/json' }, body: bigBefore },
    finalResponse: { status: 200, reason: 'OK', headers: { 'content-type': 'application/json' }, body: bigAfter },
  };
}

describe('parseImportedCalls with interception records', () => {
  it('brings back the interception record on a split inbound call and a whole outbound one', () => {
    const [parent, child] = nestedFixture();
    const record = interceptedRecord();
    const { payload, result } = roundTrip([{ ...parent, interception: record }, { ...child, interception: record }]);

    // Written once per call: on the split call's REQUEST event, never duplicated onto its response.
    const parentEvents = payload.events.filter((e) => e.callId === 'parent');
    expect(parentEvents.map((e) => 'interception' in e && !!e.interception)).toEqual([true, false]);

    const byId = new Map(result.calls.map((c) => [c.id, c]));
    expect(byId.get('parent')!.interception).toEqual(record);
    expect(byId.get('child')!.interception).toEqual(record);
  });

  it('leaves a call nothing touched without a record', () => {
    const { payload, result } = roundTrip(nestedFixture());
    expect(JSON.stringify(payload)).not.toContain('"interception"');
    expect(result.calls.every((c) => c.interception === undefined)).toBeTrue();
  });
});

describe('parseImportedCalls with WebSocket messages', () => {
  it('round-trips every message on a WebSocket call, untruncated', () => {
    const bigContent = 'x'.repeat(500_000);
    const wsMessages = [
      { seq: 1, direction: 'client' as const, tsMillis: 1000, type: 'text' as const, content: 'hello' },
      { seq: 2, direction: 'server' as const, tsMillis: 2000, type: 'text' as const, content: bigContent, action: 'edited', originalContent: 'small' },
      { seq: 3, direction: 'client' as const, tsMillis: 3000, type: 'binary' as const, contentBase64: 'AAA=' },
    ];
    const wsCall = call({ id: 'ws-call', startMs: 0, durationMs: 1, response: { status: 101, headers: {}, body: '' }, wsMessages });

    const { payload, result } = roundTrip([wsCall]);

    const event = payload.events.find((e) => e.callId === 'ws-call') as { wsMessages?: readonly unknown[] };
    expect(event.wsMessages).toEqual(wsMessages);

    const imported = result.calls.find((c) => c.id === 'ws-call')!;
    expect(imported.wsMessages).toEqual(wsMessages);
    expect((imported.wsMessages![1] as { content: string }).content.length).toBe(500_000);
  });

  it('leaves a call with no WebSocket messages without the field', () => {
    const { payload, result } = roundTrip(nestedFixture());
    expect(JSON.stringify(payload)).not.toContain('"wsMessages"');
    expect(result.calls.every((c) => c.wsMessages === undefined)).toBeTrue();
  });
});
