import { TestBed } from '@angular/core/testing';
import { FieldDef, FieldValues, Pill } from '../../core/models/logs.model';
import { LogFilterEditorComponent } from './log-filter-editor.component';

function field(label: string): FieldDef {
  return {
    index: 0, path: label, label, type: 'STRING', typeSource: 'AUTO', format: '', matchRate: 1, invalidCount: 0, suggestBoolean: false,
    searchMode: 'EXACT', role: null, sensitive: false, duplicateOf: null, firstSeenLine: 0, sample: null, roleRank: 0,
  };
}

const VALUES: FieldValues = {
  window: 100,
  sampled: 100,
  fields: { level: { presence: 100, top: [{ value: 'ERROR', count: 80 }, { value: 'WARN', count: 4 }, { value: 'INFO', count: 16 }] } },
};

describe('LogFilterEditorComponent (one filter as a form)', () => {
  function make(pill: Pill | null = null) {
    const f = TestBed.createComponent(LogFilterEditorComponent);
    f.componentRef.setInput('fields', [field('level'), field('message.methodName')]);
    f.componentRef.setInput('values', VALUES);
    f.componentRef.setInput('pill', pill);
    f.detectChanges();
    const saved: Pill[] = [];
    f.componentInstance.save.subscribe((p) => saved.push(p));
    return { f, c: f.componentInstance, saved, el: f.nativeElement as HTMLElement };
  }

  it('suggests field names that contain what was typed, and a picked value becomes an "is" filter', () => {
    const { f, c, saved, el } = make();
    c.onField('method');
    f.detectChanges();
    expect(c.suggestions().map((s) => s.label)).toEqual(['message.methodName']);
    c.pickField('level');
    f.detectChanges();
    const chips = Array.from(el.querySelectorAll('.lg-fed-sugg button')).map((b) => b.textContent!.trim());
    expect(chips).toEqual(['ERROR80', 'WARN4', 'INFO16']);
    c.toggleValue('ERROR');
    c.apply();
    expect(saved).toEqual([jasmine.objectContaining({ op: 'EQ', field: 'level', value: 'ERROR' })]);
  });

  it('several clicked values make one "is any of" filter, and Exclude negates it', () => {
    const { c, saved } = make();
    c.pickField('level');
    c.toggleValue('ERROR');
    c.toggleValue('WARN');
    c.include.set(false);
    c.apply();
    const p = saved[0];
    expect(p.values).toEqual(['ERROR', 'WARN']);
    expect(p.op === 'NEQ' || p.not === true).toBeTrue();
  });

  it('an unknown field name is refused with a reason', () => {
    const { f, c, saved } = make();
    c.onField('nope');
    c.onValue('x');
    c.apply();
    f.detectChanges();
    expect(saved.length).toBe(0);
    expect(c.fieldError()).toContain('nope');
  });

  it('changing the condition keeps the value, both ways', () => {
    const { c, saved } = make({ op: 'EQ', field: 'level', value: 'ERROR' });
    c.setCondition('contains');
    expect(c.value()).toBe('ERROR');
    c.setCondition('is');
    expect(c.valuesList()).toEqual(['ERROR']);
    c.setCondition('contains');
    c.apply();
    expect(saved[0]).toEqual(jasmine.objectContaining({ op: 'CONTAINS', field: 'level', value: 'ERROR' }));
  });

  it('editing keeps the AND/OR join of the filter it edits', () => {
    const { c, saved } = make({ op: 'EQ', field: 'level', value: 'ERROR', or: true });
    c.toggleValue('WARN');
    c.apply();
    expect(saved[0].or).toBeTrue();
    expect(saved[0].values).toEqual(['ERROR', 'WARN']);
  });
});
