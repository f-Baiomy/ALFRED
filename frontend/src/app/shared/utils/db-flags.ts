import { DbFlag, DbFlagType } from '../../core/models/db-capture.model';
import type { DbDetailTab } from '../../components/db-capture/db-window-state';

/**
 * The database window's flags (mock: the chips under the header): label, severity and where a click takes you.
 * The backend computes them (StatementFlags.java) and sends them worst first; this only presents them.
 */

/** Where a flag jumps: the statement (or supplier marker) and the tab to open, or the group to unfold. */
export interface FlagTarget {
  readonly seq: number;
  readonly tab?: DbDetailTab;
  /** A group the flag is about - unfolded and flashed instead of one statement. */
  readonly groupTxId?: string;
}

const TAB: Partial<Record<DbFlagType, DbDetailTab>> = {
  NO_WHERE: 'deleted',
  LARGE_DELETE: 'deleted',
  CASCADE: 'deleted',
  BEFORE_NOT_CAPTURED: 'deleted',
  FAILED: 'error',
  FAILED_SWALLOWED: 'error',
  HUGE_RESULT: 'rows',
};

export function flagTarget(flag: DbFlag): FlagTarget | null {
  const seq = flag.seqs[0];
  if (seq == null) return null;
  if (flag.type === 'ROLLED_BACK' && flag.group) return { seq, groupTxId: flag.group };
  return { seq, tab: TAB[flag.type] };
}

export function isBadFlag(flag: DbFlag): boolean {
  return flag.severity === 'BAD';
}

export function flagText(flag: DbFlag): string {
  const d = flag.detail ?? {};
  const at = (k: string) => (d[k] ? ` · ${d[k]}` : '');
  switch (flag.type) {
    case 'NO_WHERE': return `${d['verb'] ?? 'DELETE'} without WHERE${at('table')}${d['rows'] ? ` · ${d['rows']} rows` : ''}`;
    case 'FAILED_SWALLOWED': return `Failed and swallowed${at('error')} · the call still answered normally`;
    case 'FAILED': return `Failed${at('error')}${at('table')}`;
    case 'ROLLED_BACK': return `Rolled back${at('tx')}${d['writes'] ? ` · ${d['writes']} writes not saved` : ''}`;
    case 'LOCK_DURING_SUPPLIER_CALL': return `Row lock held during supplier call${at('tx')}`;
    case 'CASCADE': return `Cascade${d['table'] ? ` · ${d['table']} → ${d['children'] ?? 'children'}` : ''} not visible`;
    case 'BEFORE_NOT_CAPTURED': return `Not captured${d['count'] ? ` · ${d['count']} writes have no before-image` : ' · no before-image'}`;
    case 'REPEATED_QUERY': return `${d['cacheable'] === 'true' ? 'Cacheable' : 'N+1'}${at('table')}${d['count'] ? ` ×${d['count']}` : ''}`;
    case 'SLOW': return `Slow${d['ms'] ? ` · ${d['ms']} ms` : ''}${d['baselineMs'] ? ` (round trip ≈ ${d['baselineMs']} ms)` : ''}${at('table')}`;
    case 'DUPLICATE': return `Exact duplicates${at('table')}${d['duplicates'] ? ` · ${d['duplicates']} repeats of the same query + params` : ''} - cache per request`;
    case 'TX_PER_STATEMENT': return `Transaction per statement${d['transactions'] ? ` · ${d['transactions']} transactions for ${d['statements']} statements` : ''}`;
    case 'HUGE_RESULT': return `Huge result${d['rows'] ? ` · ${d['rows']} rows` : ''}${at('table')}`;
    case 'LARGE_DELETE': return `Large delete${at('table')}${d['rows'] ? ` · ${d['rows']} rows` : ''}`;
    default: return flag.type;
  }
}
