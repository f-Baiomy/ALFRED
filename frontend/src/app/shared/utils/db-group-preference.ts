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
