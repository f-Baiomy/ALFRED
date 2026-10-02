import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Condition } from '../../core/models/interception.model';
import { SUBJECT_OPTIONS } from '../../shared/utils/condition-edit';
import { ConditionRowComponent } from './condition-row.component';

describe('ConditionRowComponent', () => {
  let fixture: ComponentFixture<ConditionRowComponent>;
  let row: ConditionRowComponent;
  let emitted: Condition[];

  function render(condition: Condition): void {
    fixture.componentRef.setInput('condition', condition);
    fixture.detectChanges();
  }

  beforeEach(() => {
    fixture = TestBed.createComponent(ConditionRowComponent);
    row = fixture.componentInstance;
    fixture.componentRef.setInput('subjectOptions', SUBJECT_OPTIONS);
    emitted = [];
    row.conditionChange.subscribe((c) => {
      emitted.push(c);
      render(c);
    });
    render({ subject: 'RESPONSE_STATUS', operator: 'EQUALS', value: '200' });
  });

  it('a JSON field gets a list mode and JSON-only operators; leaving it drops them', () => {
    row.setSubject('RESPONSE_JSON_FIELD');
    expect(emitted.at(-1)).toEqual(jasmine.objectContaining({ subject: 'RESPONSE_JSON_FIELD', items: 'ANY' }));
    expect(row.operators().map((o) => o.value)).toContain('COUNT_AT_LEAST');

    row.setOperator('COUNT_AT_LEAST');
    row.setSubject('RESPONSE_STATUS');
    expect(emitted.at(-1)).toEqual(jasmine.objectContaining({ subject: 'RESPONSE_STATUS', operator: 'EQUALS', items: null, paths: null }));
  });

  it('adds, edits and removes extra fields', () => {
    render({ subject: 'RESPONSE_JSON_FIELD', name: 'a', operator: 'EXISTS', items: 'ANY' });
    row.addPath();
    row.setPath(0, 'b');
    expect(emitted.at(-1)).toEqual(jasmine.objectContaining({ paths: ['b'], pathsMode: 'ANY' }));
    row.removePath(0);
    expect(emitted.at(-1)).toEqual(jasmine.objectContaining({ paths: [], pathsMode: null }));
  });

  it('a header condition offers the call\'s header names', () => {
    fixture.componentRef.setInput('headerNames', [{ name: 'X-Ref', value: 'R-9' }]);
    render({ subject: 'RESPONSE_HEADER', name: '', operator: 'EXISTS' });
    expect(fixture.nativeElement.querySelector('app-name-suggest')).toBeTruthy();
  });

  it('shows the joiner and removes itself', () => {
    let removed = false;
    row.remove.subscribe(() => (removed = true));
    fixture.componentRef.setInput('joiner', 'or');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.cond-and').textContent.trim()).toBe('or');
    (fixture.nativeElement.querySelector('.icon-btn.danger') as HTMLButtonElement).click();
    expect(removed).toBeTrue();
  });
});
