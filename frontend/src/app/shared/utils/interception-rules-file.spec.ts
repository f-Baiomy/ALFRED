import { InterceptionRule } from '../../core/models/interception.model';
import {
  RULES_FILE_MARKER,
  buildRulesFile,
  copyName,
  parseRulesFile,
  rulesFileName,
  toRuleDraft,
} from './interception-rules-file';

function rule(overrides: Partial<InterceptionRule> = {}): InterceptionRule {
  return {
    id: 'rule-1',
    name: 'Pause Sabre orders',
    description: 'For the booking bug',
    enabled: true,
    priority: 100,
    stopProcessing: false,
    match: { source: 'outbound', methods: ['POST'], host: 'api.sabre.com' },
    actions: [{ type: 'PAUSE_REQUEST', timeoutSeconds: 30, onTimeout: 'release' }],
    createdAt: '2026-09-01T10:00:00Z',
    updatedAt: '2026-09-02T10:00:00Z',
    ...overrides,
  } as InterceptionRule;
}

describe('the interception rules file', () => {
  describe('what gets written', () => {
    it('leaves out the three fields the server assigns', () => {
      // Carrying an id would raise "does importing overwrite the rule with that id?", and both
      // answers are bad. Rules always import as new rules.
      const draft = toRuleDraft(rule()) as unknown as Record<string, unknown>;

      expect(draft['id']).toBeUndefined();
      expect(draft['createdAt']).toBeUndefined();
      expect(draft['updatedAt']).toBeUndefined();
    });

    it('keeps everything that says what the rule DOES', () => {
      const draft = toRuleDraft(rule());

      expect(draft.name).toBe('Pause Sabre orders');
      expect(draft.description).toBe('For the booking bug');
      expect(draft.priority).toBe(100);
      expect(draft.stopProcessing).toBeFalse();
      expect(draft.match).toEqual(rule().match);
      expect(draft.actions).toEqual(rule().actions);
    });

    it('records whether the rule was on, and leaves the safety decision to the importer', () => {
      // The file should describe truthfully; the IMPORT is what forces everything off. Writing
      // `enabled: false` here would make an export a worse record than the thing it exported.
      expect(toRuleDraft(rule({ enabled: true })).enabled).toBeTrue();
      expect(toRuleDraft(rule({ enabled: false })).enabled).toBeFalse();
    });

    it('stamps a version that doubles as a fingerprint', () => {
      const file = buildRulesFile([rule()]) as unknown as Record<string, unknown>;

      expect(file[RULES_FILE_MARKER]).toBe(1);
      expect(typeof file['exportedAt']).toBe('string');
    });

    it('never writes the master switch into a file', () => {
      // A deployment-level setting, not a rule. No file should be able to turn interception on.
      const keys = Object.keys(buildRulesFile([rule()]));

      expect(keys).toEqual([RULES_FILE_MARKER, 'exportedAt', 'rules']);
    });

    it('names a single-rule file after the rule', () => {
      const name = rulesFileName([rule()], new Date('2026-09-20T16:40:55Z'));

      expect(name).toContain('alfred-rule-pause-sabre-orders');
      expect(name.endsWith('.json')).toBeTrue();
      // Colons and dots are illegal in a Windows filename, and this app runs on one.
      expect(name).not.toContain(':');
    });

    it('names a multi-rule file generically', () => {
      expect(rulesFileName([rule(), rule()], new Date('2026-09-20T16:40:55Z')))
        .toBe('alfred-interception-rules-2026-09-20T164055000.json');
    });

    it('survives a rule whose name has nothing filename-shaped in it', () => {
      expect(rulesFileName([rule({ name: '///' })])).toContain('alfred-rule-unnamed-');
    });
  });

  describe('reading one back', () => {
    it('round-trips an export exactly', () => {
      // The property that matters: what the exporter writes is what the importer reads. Anything
      // less and a file that looks fine silently creates a different rule.
      const file = buildRulesFile([rule(), rule({ name: 'Second', enabled: false })]);

      const parsed = parseRulesFile(JSON.stringify(file));

      expect(parsed.error).toBeNull();
      expect(parsed.rules).toEqual(file.rules);
    });

    it('refuses a calls export by name, because that is the likely mistake', () => {
      // "Not a rules export" would leave somebody staring at a file that plainly contains their
      // data, wondering what is wrong with it.
      const parsed = parseRulesFile(JSON.stringify({ events: [{ id: 'c1' }], about: {} }));

      expect(parsed.rules).toEqual([]);
      expect(parsed.error).toContain('calls export');
    });

    it('refuses anything else that is not a rules export', () => {
      expect(parseRulesFile('{"hello":1}').error).toContain('does not look like');
      expect(parseRulesFile('[]').error).toContain('does not look like');
      expect(parseRulesFile('not json at all').error).toContain('not valid JSON');
    });

    it('refuses a file from a newer Alfred rather than guessing at it', () => {
      const parsed = parseRulesFile(JSON.stringify({ [RULES_FILE_MARKER]: 99, rules: [{ name: 'x' }] }));

      expect(parsed.rules).toEqual([]);
      expect(parsed.error).toContain('newer version');
    });

    it('says so when the file is a rules export with no rules in it', () => {
      expect(parseRulesFile(JSON.stringify({ [RULES_FILE_MARKER]: 1, rules: [] })).error)
        .toContain('no rules in it');
      expect(parseRulesFile(JSON.stringify({ [RULES_FILE_MARKER]: 1 })).error)
        .toContain('no rules in it');
    });

    it('drops entries that are not objects rather than failing the whole file', () => {
      const parsed = parseRulesFile(
        JSON.stringify({ [RULES_FILE_MARKER]: 1, rules: [{ name: 'real' }, 'nonsense', null] })
      );

      expect(parsed.error).toBeNull();
      expect(parsed.rules.length).toBe(1);
    });

    it('does not validate the rules itself', () => {
      // Deliberate: RuleValidator on the backend is the single source of truth about what a
      // usable rule is, and a second opinion here would drift from it. A structurally-readable
      // rule reaches the import endpoint and is rejected there, with the real reasons.
      const parsed = parseRulesFile(JSON.stringify({ [RULES_FILE_MARKER]: 1, rules: [{ nonsense: true }] }));

      expect(parsed.error).toBeNull();
      expect(parsed.rules.length).toBe(1);
    });
  });

  describe('copyName', () => {
    it('appends (copy) to a name that has none', () => {
      expect(copyName('Search rules', ['Search rules'])).toBe('Search rules (copy)');
    });

    it('counts rather than nesting, so three copies are three names', () => {
      const existing = ['Search rules', 'Search rules (copy)'];

      expect(copyName('Search rules', existing)).toBe('Search rules (copy 2)');
      expect(copyName('Search rules (copy)', existing)).toBe('Search rules (copy 2)');
    });

    it('continues the series when copying a copy, instead of "(copy) (copy)"', () => {
      const existing = ['A', 'A (copy)', 'A (copy 2)'];

      expect(copyName('A (copy 2)', existing)).toBe('A (copy 3)');
    });

    it('leaves a name that merely mentions copy alone', () => {
      expect(copyName('Copy of the old rule', [])).toBe('Copy of the old rule (copy)');
    });
  });
});
