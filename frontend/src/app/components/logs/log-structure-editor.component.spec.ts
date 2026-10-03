import { FieldDef } from '../../core/models/logs.model';
import { withRole } from './log-structure-editor.component';

function field(index: number, label: string, role: FieldDef['role'] = null, roleRank = 0): FieldDef {
  return {
    index, path: label, label, type: 'STRING', typeSource: 'AUTO', format: '', matchRate: 1, invalidCount: 0, suggestBoolean: false,
    searchMode: 'EXACT', role, sensitive: false, duplicateOf: null, firstSeenLine: 0, sample: null, roleRank,
  };
}

describe('withRole (a role on several fields)', () => {
  it('keeps the role on the first field and adds the second one after it', () => {
    const out = withRole([field(0, '@timestamp', 'TIME', 1), field(1, 'time')], 'time', 'TIME');
    expect(out.map((f) => [f.label, f.role, f.roleRank])).toEqual([
      ['@timestamp', 'TIME', 1],
      ['time', 'TIME', 2],
    ]);
  });

  it('closes the gap when a field leaves a role', () => {
    const out = withRole([field(0, 'a', 'TIME', 1), field(1, 'b', 'TIME', 2), field(2, 'c', 'TIME', 3)], 'a', null);
    expect(out.map((f) => [f.label, f.role, f.roleRank])).toEqual([
      ['a', null, 0],
      ['b', 'TIME', 1],
      ['c', 'TIME', 2],
    ]);
  });

  it('moving a field to another role renumbers both', () => {
    const out = withRole([field(0, 'a', 'LEVEL', 1), field(1, 'b', 'LEVEL', 2), field(2, 'c', 'MESSAGE', 1)], 'a', 'MESSAGE');
    expect(out.map((f) => [f.label, f.role, f.roleRank])).toEqual([
      ['a', 'MESSAGE', 2],
      ['b', 'LEVEL', 1],
      ['c', 'MESSAGE', 1],
    ]);
  });
});
