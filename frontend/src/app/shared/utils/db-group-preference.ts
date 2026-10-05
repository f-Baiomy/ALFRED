/**
 * "Group by transaction" - one per-browser choice shared by the database window and the export dialog. A convenience,
 * so storage that is blocked or cleared simply means the default (grouped).
 */
const KEY = 'alfred.dbCapture.groupByTransaction';

export function readGroupByTransaction(): boolean {
  try {
    return localStorage.getItem(KEY) !== '0';
  } catch {
    return true;
  }
}

export function saveGroupByTransaction(grouped: boolean): void {
  try {
    localStorage.setItem(KEY, grouped ? '1' : '0');
  } catch {
    // private window / blocked storage: the choice lasts for this page only
  }
}

const QUERY_KEY = 'alfred.dbCapture.groupByQuery';
const ROWS_AS_KEY = 'alfred.dbCapture.rowsAs';

/** "Group by query" - the SQL statements one HQL query produced under that query. On by default. */
export function readGroupByQuery(): boolean {
  try {
    return localStorage.getItem(QUERY_KEY) !== '0';
  } catch {
    return true;
  }
}

export function saveGroupByQuery(grouped: boolean): void {
  try {
    localStorage.setItem(QUERY_KEY, grouped ? '1' : '0');
  } catch {
    // the choice lasts for this page only
  }
}

/** "Show rows as": the query the code wrote (HQL, default) or the SQL that was sent. */
export function readRowsAs(): 'hql' | 'sql' {
  try {
    return localStorage.getItem(ROWS_AS_KEY) === 'sql' ? 'sql' : 'hql';
  } catch {
    return 'hql';
  }
}

export function saveRowsAs(rowsAs: 'hql' | 'sql'): void {
  try {
    localStorage.setItem(ROWS_AS_KEY, rowsAs);
  } catch {
    // the choice lasts for this page only
  }
}

const SUMMARY_KEY = 'alfred.dbCapture.summaryOpen';

/** The database window's summary panel (timeline + findings) - closed by default, open or closed remembered. */
export function readSummaryOpen(): boolean {
  try {
    return localStorage.getItem(SUMMARY_KEY) === '1';
  } catch {
    return false;
  }
}

export function saveSummaryOpen(open: boolean): void {
  try {
    localStorage.setItem(SUMMARY_KEY, open ? '1' : '0');
  } catch {
    // the choice lasts for this page only
  }
}

/** One of the database window's remembered layout choices (`alfred.dbCapture.<key>`); `fallback` when unset or blocked. */
export function readDbPref(key: string, fallback: string): string {
  try {
    return localStorage.getItem(`alfred.dbCapture.${key}`) ?? fallback;
  } catch {
    return fallback;
  }
}

export function saveDbPref(key: string, value: string): void {
  try {
    localStorage.setItem(`alfred.dbCapture.${key}`, value);
  } catch {
    // the choice lasts for this page only
  }
}
