/** The board's Cycles tab (specs/033). */

export type CycleDirection = 'INBOUND' | 'OUTBOUND';

/** One METHOD + path of a cycle (no query string). */
export interface CycleEndpoint {
  readonly direction: CycleDirection;
  readonly method: string;
  readonly path: string;
  readonly calls: number;
  readonly failed: number;
  readonly lastStatus: number | null;
  readonly medianMs: number | null;
  readonly maxMs: number | null;
  readonly lastAt: string | null;
}

/** One call of a cycle, in time order. */
export interface CyclePoint {
  readonly direction: CycleDirection;
  readonly callId: string;
  readonly at: string | null;
  readonly method: string;
  readonly path: string;
  readonly status: number | null;
  readonly ms: number | null;
  readonly failed: boolean;
}

/** GET /session-cycles/{id}/summary - counted from the captured calls, no bodies. */
export interface CycleSummary {
  readonly cycleId: string;
  readonly calls: number;
  readonly failed: number;
  readonly firstAt: string | null;
  readonly lastAt: string | null;
  readonly medianMs: number | null;
  readonly hosts: readonly string[];
  readonly endpoints: readonly CycleEndpoint[];
  readonly strip: readonly CyclePoint[];
  readonly inboundCallIds: readonly string[];
}

export type RetestVerdict = 'PASSES' | 'PARTIAL' | 'FLAKY' | 'FAILS' | 'NO_CALLS' | 'NOT_CHECKABLE';

/** A card a cycle tests, with its verdict in that cycle (null when not checked). */
export interface TestedCard {
  readonly cardId: string;
  readonly number: number;
  readonly title: string;
  readonly status: string;
  readonly verdict: RetestVerdict | null;
  readonly summary: string | null;
}

/** GET /board/boards/{id}/cycle-rows - one per cycle of the board. */
export interface BoardCycleRow {
  readonly cycleId: string;
  /** What the board recorded it for; null for a cycle related by hand or before specs/033. */
  readonly kind: 'REC' | 'RETEST' | null;
  readonly baseline: boolean;
  readonly archived: boolean;
  readonly relatedAt: string | null;
  readonly tests: readonly TestedCard[];
  readonly otherBoards: readonly string[];
}

/** GET /board/cards/{id}/cycle-verdicts - a card's verdict in one cycle. */
export interface CardCycleVerdict {
  readonly cycleId: string;
  readonly name: string;
  /** The cycle the card was found in. */
  readonly home: boolean;
  readonly verdict: RetestVerdict | null;
  readonly calls: number;
  readonly summary: string | null;
}

/** What a new recording is for: the cards a re-test tests, a name, a description. */
export interface RecordSpec {
  readonly cards?: readonly number[];
  readonly name?: string;
  readonly description?: string;
}
