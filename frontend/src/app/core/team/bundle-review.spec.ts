import { WriteStep } from './team.models';
import { azureCheck, createRows, editRows, isEdit, wideReasons } from './bundle-review';

const step = (kind: WriteStep['kind'], payload: Record<string, string>, ticked = true): WriteStep => ({ kind, payload, ticked, unmasked: false });

describe('bundle review (specs/038)', () => {
  it('shows every value a new item gets: parent, assignee, fields, tags, links', () => {
    const rows = createRows(step('CREATE', {
      type: 'Task', title: 'BE - Portal', parent: '62565', assignee: 'f.biomy@tildetech.ae', tags: 'Back-end',
      fields: '{"Microsoft.VSTS.Common.Activity":"Development","Microsoft.VSTS.Scheduling.OriginalEstimate":16}',
      links: '[{"kind":"Related","id":"62555"}]',
    }));
    expect(rows.map((r) => `${r.label}=${r.after}`)).toEqual(['Parent=AB#62565', 'Assigned to=f.biomy@tildetech.ae', 'Activity=Development',
      'OriginalEstimate=16', 'Tags=Back-end', 'Related=AB#62555']);
    expect(createRows(step('CREATE', { type: 'Task', title: 'x', parent: '' }))[0]).toEqual({ label: 'Parent', before: null, after: '(none)' });
  });

  it('reads an edit as before -> after for each field, the parent and the tags', () => {
    const s = step('FIELD', { fields: '{"Microsoft.VSTS.Scheduling.RemainingWork":8}', parent: '62555', addTags: 'Back-end',
      fromFields: '{"Microsoft.VSTS.Scheduling.RemainingWork":"16"}', fromParent: '62565', fromTags: 'old' });
    expect(isEdit(s)).toBeTrue();
    expect(isEdit(step('FIELD', { field: 'Microsoft.VSTS.Common.Priority', value: '1' }))).toBeFalse();
    expect(editRows(s)).toEqual([
      { label: 'RemainingWork', before: '16', after: '8' },
      { label: 'Parent', before: 'AB#62565', after: 'AB#62555' },
      { label: 'Tags', before: 'old', after: '+Back-end' },
    ]);
    // Azure's values now, when the review read them, are the "before"
    expect(editRows(s, '{"Microsoft.VSTS.Scheduling.RemainingWork":"12"}')[0].before).toBe('12');
  });

  it("says Azure's answer to the draft", () => {
    expect(azureCheck(step('CREATE', { azureCheck: 'ok' }))!.tone).toBe('ok');
    expect(azureCheck(step('CREATE', { azureCheck: 'refused: TF401320: Activity' }))!.text).toContain('TF401320');
    expect(azureCheck(step('CREATE', { azureCheck: 'not checked - no Azure token in Alfred yet' }))!.tone).toBe('dim');
    expect(azureCheck(step('COMMENT', { text: 'x' }))).toBeNull();
  });

  it('asks once more only for a wide change: many items, a close, a re-parent, work for someone else', () => {
    expect(wideReasons({ item: '1' }, [step('FIELD', { field: 'Microsoft.VSTS.Common.Priority', value: '1' })])).toEqual([]);
    const many = Array.from({ length: 6 }, (_, i) => step('FIELD', { item: String(100 + i), fields: '{"System.IterationPath":"S2"}' }));
    expect(wideReasons({ item: null }, many)[0]).toContain('6 work items');
    expect(wideReasons({ item: '1' }, [step('STATE', { state: 'Removed' })])[0]).toContain('closes');
    expect(wideReasons({ item: '1' }, [step('FIELD', { parent: '9' })])[0]).toContain('another parent');
    expect(wideReasons({ item: null }, [step('CREATE', { type: 'Task', title: 'x', assignee: 'omar@x.ae' })], 'f.biomy@tildetech.ae')[0])
      .toContain('omar@x.ae');
    expect(wideReasons({ item: null }, [step('CREATE', { type: 'Task', title: 'x', assignee: 'f.biomy@tildetech.ae' })], 'f.biomy@tildetech.ae')).toEqual([]);
    expect(wideReasons({ item: '1' }, [step('STATE', { state: 'Removed' }, false)])).toEqual([]); // unticked: not sent
  });
});
