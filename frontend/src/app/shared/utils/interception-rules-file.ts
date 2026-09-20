import { InterceptionRule, InterceptionRuleDraft } from '../../core/models/interception.model';

/**
 * Reading and writing the interception-rules export file.
 *
 * The export unit is deliberately `InterceptionRuleDraft` - exactly what POST /rules accepts -
 * rather than a format of its own. That makes importing *create*, which means the whole existing
 * RuleValidator runs against an imported rule with no second code path to drift from it. A rules
 * file is executable: it can hold callers open, abort connections and rewrite bodies on live
 * traffic. It must not be able to reach the engine by a route the editor does not also use.
 */

/**
 * Version and fingerprint in one field.
 *
 * A calls export is also a `.json`, and feeding one to this importer has to say so rather than
 * half-working its way through an array of the wrong shape.
 */
export const RULES_FILE_MARKER = 'alfredInterceptionRules';
export const RULES_FILE_VERSION = 1;

export interface RulesFile {
  readonly alfredInterceptionRules: number;
  readonly exportedAt: string;
  readonly rules: readonly InterceptionRuleDraft[];
}

export interface RulesFileParse {
  readonly rules: readonly InterceptionRuleDraft[];
  /** Why this file could not be read at all. Null when `rules` is usable. */
  readonly error: string | null;
}

/**
 * Strips everything the server assigns.
 *
 * `id`, `createdAt` and `updatedAt` are left out on purpose, not by omission. Carrying an id
 * would raise "does importing overwrite the rule with that id?", and both answers are bad: yes
 * silently destroys work, no makes the field a lie. Rules always import as new rules.
 *
 * `enabled` IS kept, so the file is a faithful record of what was exported. Forcing it off is the
 * importer's job, not the exporter's - the file should describe, the import should be safe.
 */
export function toRuleDraft(rule: InterceptionRule): InterceptionRuleDraft {
  return {
    name: rule.name,
    description: rule.description ?? null,
    enabled: rule.enabled,
    priority: rule.priority,
    stopProcessing: rule.stopProcessing,
    match: rule.match,
    actions: rule.actions,
  };
}

export function buildRulesFile(rules: readonly InterceptionRule[], now = new Date()): RulesFile {
  return {
    [RULES_FILE_MARKER]: RULES_FILE_VERSION,
    exportedAt: now.toISOString(),
    rules: rules.map(toRuleDraft),
  } as RulesFile;
}

/** `alfred-interception-rules-2026-09-20T164055.json`, or named after the one rule it holds. */
export function rulesFileName(rules: readonly InterceptionRule[], now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '').replace(/Z$/, '');
  if (rules.length === 1) {
    const slug = rules[0].name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
    return `alfred-rule-${slug || 'unnamed'}-${stamp}.json`;
  }
  return `alfred-interception-rules-${stamp}.json`;
}

/**
 * Reads a file back, refusing anything that is not recognisably a rules export.
 *
 * Refusing loudly matters more here than being permissive. Half-importing an unrecognised file
 * would create rules from whatever objects happened to have a `name` - and those rules would then
 * be sitting in a list of things that change live traffic.
 */
export function parseRulesFile(text: string): RulesFileParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { rules: [], error: `That file is not valid JSON: ${(e as Error).message}` };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { rules: [], error: 'That file does not look like an Alfred rules export.' };
  }

  const file = parsed as Record<string, unknown>;
  if (typeof file[RULES_FILE_MARKER] !== 'number') {
    // Named specifically, because reaching for the wrong export is the likely mistake and
    // "not a rules export" leaves somebody staring at a file that plainly contains their data.
    const looksLikeCalls = Array.isArray(file['events']) || Array.isArray(file['calls']);
    return {
      rules: [],
      error: looksLikeCalls
        ? 'That is a calls export, not a rules export. Import it from Live Calls instead.'
        : 'That file does not look like an Alfred rules export.',
    };
  }

  if ((file[RULES_FILE_MARKER] as number) > RULES_FILE_VERSION) {
    return {
      rules: [],
      error: `That file was written by a newer version of Alfred (format ${file[RULES_FILE_MARKER]}). Update this one first.`,
    };
  }

  if (!Array.isArray(file['rules'])) {
    return { rules: [], error: 'That rules export has no rules in it.' };
  }

  const rules = (file['rules'] as unknown[]).filter(
    (rule): rule is InterceptionRuleDraft => typeof rule === 'object' && rule !== null && !Array.isArray(rule)
  );
  if (rules.length === 0) {
    return { rules: [], error: 'That rules export has no rules in it.' };
  }
  return { rules, error: null };
}

/**
 * `Search rules` -> `Search rules (copy)` -> `Search rules (copy 2)`.
 *
 * Counting rather than always appending "(copy)" so duplicating three times gives three
 * distinguishable names instead of "(copy) (copy) (copy)", and so duplicating a copy continues
 * the series rather than nesting.
 */
export function copyName(name: string, existing: readonly string[]): string {
  const taken = new Set(existing);
  const base = name.replace(/ \(copy(?: \d+)?\)$/, '');
  let candidate = `${base} (copy)`;
  for (let n = 2; taken.has(candidate); n++) {
    candidate = `${base} (copy ${n})`;
  }
  return candidate;
}
