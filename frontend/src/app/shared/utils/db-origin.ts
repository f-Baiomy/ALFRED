import { CapturedStatement, StatementOrigin } from '../../core/models/db-capture.model';

/**
 * Where a statement came from (mock: specs/006-db-capture/hql-mock.html). One rule for all three cases - what the
 * code wrote on top, what the database received below, and a line saying what changed in between:
 *  - HQL / Criteria: translated to SQL (always different);
 *  - NATIVE through Hibernate: usually the same text with `:name` turned into `?` - when only that changed the two
 *    collapse into one card, when more changed (paging, alias expansion, a lock hint) the SQL is marked "differs";
 *  - JDBC: written as SQL and sent as written - one card. Shown as "JDBC" only in a call where Hibernate made other
 *    statements; in a call without any ORM there is nothing to tell apart.
 * Events (lazy load, entity load, flush) have no query of the code's - they say what they were instead.
 */

export type OriginBadgeClass = 'hql' | 'nat' | 'auto';

export interface OriginBadge {
  readonly label: string;
  readonly cls: OriginBadgeClass;
  readonly title: string;
}

const QUERY_KINDS = new Set(['HQL', 'NATIVE', 'CRITERIA']);

/** A query the code wrote (has text), as opposed to an event Hibernate ran on its own. */
export function isQueryOrigin(o: StatementOrigin | null | undefined): boolean {
  return !!o && QUERY_KINDS.has(o.kind);
}

/** True when any statement of the call came from an ORM - only then do JDBC statements get a "JDBC" badge. */
export function hasOrigins(statements: readonly CapturedStatement[]): boolean {
  return statements.some((s) => !!s.origin);
}

export function originBadge(s: CapturedStatement, callHasOrigins: boolean): OriginBadge | null {
  const o = s.origin;
  if (!o) {
    if (!callHasOrigins || s.kind === 'COMMIT' || s.kind === 'ROLLBACK' || s.kind === 'SAVEPOINT' || s.kind === 'ROLLBACK_TO_SAVEPOINT') return null;
    return { label: 'JDBC', cls: 'auto', title: 'Written as SQL in the code (JDBC, JdbcTemplate, MyBatis ...) and sent as written' };
  }
  switch (o.kind) {
    case 'HQL':
      return { label: 'HQL', cls: 'hql', title: 'Hibernate translated an HQL/JPQL query of the code into this SQL' };
    case 'CRITERIA':
      return { label: 'CRITERIA', cls: 'hql', title: 'Built with the Criteria API and translated by Hibernate' };
    case 'NATIVE':
      return { label: 'NATIVE', cls: 'nat', title: 'Native SQL the code wrote (createNativeQuery), run through Hibernate' };
    case 'LAZY_LOAD':
      return { label: 'LAZY LOAD', cls: 'auto', title: 'Hibernate loaded a lazy collection the code touched' };
    case 'LOAD':
      return { label: 'LOAD', cls: 'auto', title: 'Hibernate loaded an entity by its id' };
    case 'FLUSH':
      return { label: 'FLUSH', cls: 'auto', title: 'Hibernate wrote changed entities to the database (flush)' };
    default:
      return { label: 'HIBERNATE', cls: 'auto', title: "Hibernate's own SQL - an id from a sequence, a version check ..." };
  }
}

/** One line for an event (or a query without text): what Hibernate did. */
export function originSummary(o: StatementOrigin): string {
  const ref = o.entity ? `${o.entity}${o.entityId != null ? '#' + o.entityId : ''}` : '';
  switch (o.kind) {
    case 'LAZY_LOAD':
      return `${o.role ?? 'a collection'}${o.entityId != null ? ` of ${o.entity ?? ''}#${o.entityId}` : ''}`;
    case 'LOAD':
      return ref || 'an entity';
    case 'FLUSH':
      if (o.action === 'COLLECTION') return `${o.role ?? 'a collection'}${o.entityId != null ? ` of ${o.entity ?? ''}#${o.entityId}` : ''}`;
      if (!o.action) return 'changed entities';
      return `${o.action.toLowerCase()} ${ref || 'an entity'}${o.changed?.length ? ` · changed: ${o.changed.join(', ')}` : ''}`;
    case 'HIBERNATE':
      return "Hibernate's own SQL";
    default:
      return o.text ?? o.name ?? 'query';
  }
}

/** The longer sentence an event's detail shows in place of the query card. */
export function originExplanation(o: StatementOrigin): string {
  switch (o.kind) {
    case 'LAZY_LOAD':
      return `Lazy load of ${o.role ?? 'a collection'}${o.entityId != null ? ` for ${o.entity ?? ''}#${o.entityId}` : ''} - the code touched a collection Hibernate had not loaded yet.`;
    case 'LOAD':
      return `Load of ${o.entity ?? 'an entity'}${o.entityId != null ? '#' + o.entityId : ''} by its id (session.get/find, a proxy being initialised, or an eager association).`;
    case 'FLUSH':
      if (o.action === 'COLLECTION') return `Flush of the collection ${o.role ?? ''}${o.entityId != null ? ` of ${o.entity ?? ''}#${o.entityId}` : ''}.`;
      if (o.action) {
        return `Flush - ${o.action.toLowerCase()} of ${o.entity ?? 'an entity'}${o.entityId != null ? '#' + o.entityId : ''}${
          o.changed?.length ? `, fields changed: ${o.changed.join(', ')}` : ''}.`;
      }
      return 'Flush of changed entities.';
    default:
      return "Hibernate's own SQL, outside any query of the code's - an id from a sequence, a version check, a lock.";
  }
}

/** "first 50, from row 101" - the paging the code asked for. */
export function pagingText(o: StatementOrigin): string | null {
  if (o.firstResult == null && o.maxResults == null) return null;
  const parts: string[] = [];
  if (o.maxResults != null) parts.push(`first ${o.maxResults}`);
  if (o.firstResult) parts.push(`from row ${o.firstResult + 1}`);
  return parts.join(', ') || 'from row 1';
}

/** The text with parameters and whitespace normalised - `:name`, `?1` and `?` all become `?`. */
function normalised(sql: string): string {
  return sql
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/(^|[^:]):[A-Za-z_][A-Za-z0-9_]*/g, '$1?')
    .replace(/\?\d+/g, '?')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * How the SQL sent compares with a native query the code wrote: 'same' (sent exactly as written), 'params' (only
 * named parameters became `?` - one card) or 'changed' (Hibernate added paging, expanded aliases ... - two cards).
 */
export function nativeComparison(o: StatementOrigin, sql: string): 'same' | 'params' | 'changed' {
  const text = o.text ?? '';
  if (text.trim() === sql.trim()) return 'same';
  return normalised(text) === normalised(sql) ? 'params' : 'changed';
}

/** What Hibernate did between the code's query and the SQL - the line between the two cards. */
export function translationLine(o: StatementOrigin, sql: string, sqlCount: number): string {
  if (o.kind !== 'NATIVE') return `Hibernate translated it to ${sqlCount} SQL statement${sqlCount === 1 ? '' : 's'}`;
  const notes: string[] = [];
  if (/(^|[^:]):[A-Za-z_]/.test((o.text ?? '').replace(/'(?:[^']|'')*'/g, "''"))) notes.push('named parameters → ?');
  if (pagingText(o)) notes.push('paging wrapped around it');
  if (!notes.length) notes.push('the text was changed');
  return `Hibernate rewrote it: ${notes.join(', ')}`;
}

/** The query a statement belongs to for "Group by query": its own query, or the one an event ran inside. */
export function queryKeyOf(s: CapturedStatement): string | null {
  const o = s.origin;
  if (!o) return null;
  if (isQueryOrigin(o)) return o.id;
  return o.parentId ?? null;
}

/** The heading line above an exported query: "HQL - named query X · :id = 948 · first 50 · Dao.find(Dao.java:41) · list()". */
export function originExportLabel(s: CapturedStatement): string {
  const o = s.origin;
  if (!o) return '';
  const kind = o.kind === 'NATIVE' ? 'SQL in the code (native query)' : o.kind === 'CRITERIA' ? 'Criteria query' : 'HQL';
  const parts = [kind + (o.name ? ` - named query ${o.name}` : '')];
  for (const p of o.params ?? []) parts.push(`${p.name} = ${p.value ?? 'null'}`);
  const page = pagingText(o);
  if (page) parts.push(page);
  if (s.codeLocation) parts.push(s.codeLocation);
  if (o.method) parts.push(`${o.method}()`);
  return parts.join(' · ');
}

/** The row prefix in an export, as plain text: "HQL", "LAZY LOAD" ... or "" when there is nothing to tell. */
export function originBadgeText(s: CapturedStatement, callHasOrigins: boolean): string {
  return originBadge(s, callHasOrigins)?.label ?? '';
}
