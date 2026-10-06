import type { CallRecord } from '../src/frontend.ts';
import type { FakeAlfred } from './fake-alfred.ts';
import { IN1, T0 } from './fixtures.ts';

/** A line the agent caught (specs/009) at its place in the call's sequence. */
export function caught(n: number, seq: number, level: string, message: string, exception?: { type: string; message: string; stack: string }) {
  return {
    sourceId: 'agent', sourceName: 'agent', lineId: `c:${n}`, at: new Date(T0 + seq * 10).toISOString(), offsetMs: seq * 10, level, thread: 'default task-4',
    logger: 'com.tt.nc.MainLogger', message, matchedBy: 'CAUGHT', kept: false, raw: JSON.stringify({ message }), seq, ...(exception ? { exception } : {}),
  };
}

const STACK = 'java.lang.IllegalArgumentException: No enum constant com.tt.Status.PENDNG\n'
  + '\tat java.base/java.lang.Enum.valueOf(Enum.java:273)\n'
  + '\tat com.tt.nc.booking.FareService.confirm(FareService.java:88)\n'
  + '\tat org.jboss.resteasy.core.MethodInjectorImpl.invoke(MethodInjectorImpl.java:170)';

/** IN1: 200 that logged an ERROR with an exception and a WARN; IN2: 500 with failed supplier call; a 200 with an N+1 flag; a clean 200. */
export function seedTrouble(fake: FakeAlfred): void {
  fake.state.signals[IN1] = { logErrors: 1, logWarnings: 1, logExceptions: 1, logStatus: 'CAUGHT', logLevel: 'WARN', dbFlags: [] };
  fake.state.callLogs[IN1] = { setup: 'OK', matchedBy: 'CAUGHT', thread: null, logLevel: 'WARN', lines: [
    caught(1, 3, 'WARN', 'supplier slow: 12000 ms'),
    caught(2, 50, 'ERROR', 'No enum constant com.tt.Status.PENDNG', { type: 'java.lang.IllegalArgumentException', message: 'No enum constant com.tt.Status.PENDNG', stack: STACK }),
  ] };
  const base = fake.state.calls.find((c) => c.record.id === 'in-old-1')!.record;
  const nplus1: CallRecord = { ...base, id: 'in-nplus1', timestamp: new Date(T0 + 200_000).toISOString() };
  fake.addCall('internal', nplus1);
  fake.state.signals['in-nplus1'] = { logErrors: 0, logWarnings: 0, logExceptions: 0, logStatus: 'CAUGHT', dbFlags: ['REPEATED_QUERY'] };
}
