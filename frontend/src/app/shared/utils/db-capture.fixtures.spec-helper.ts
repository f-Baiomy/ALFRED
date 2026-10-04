import { CapturedStatement, StatementKind } from '../../core/models/db-capture.model';

/** Captured statements for specs - shaped as backend-db-capture returns them. */
let nextId = 1;
export function stmt(seq: number, kind: StatementKind, sql: string, extra: Partial<CapturedStatement> = {}): CapturedStatement {
  return {
    id: nextId++, callId: 'c1', thread: 'default task-1', seq, kind, sql, fingerprint: sql, table: null,
    params: [[]], outcome: kind === 'COMMIT' || kind === 'ROLLBACK' ? { kind: 'TX_END', txResult: kind === 'COMMIT' ? 'COMMITTED' : 'ROLLED_BACK' } : { kind: 'ROWS', rowsRead: 1 },
    startedAt: '2026-10-04T18:00:00Z', durationMicros: 1000, offsetMicros: seq * 1000, undone: false, expected: false, storedRows: 1,
    ...extra,
  };
}

