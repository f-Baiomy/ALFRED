import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { ReliveApiService } from '../../core/services/relive-api.service';
import { StepChecks } from '../../shared/utils/relive-checks';
import { FrozenCall } from '../../shared/utils/relive-types';
import { ReliveChecksEditorComponent } from './relive-checks-editor.component';

const recording: FrozenCall = {
  method: 'POST',
  url: 'https://api.example/search',
  requestHeaders: {},
  requestBody: '{}',
  status: 200,
  responseHeaders: { 'X-Ref': 'R-9' },
  responseBody: '{"journeys":[{"origin":"CAI"},{"origin":"AUH"}]}',
  timestamp: '2026-10-02T10:00:00Z',
  durationMs: 1310,
  sessionId: null,
  operationId: null,
  serviceName: 'odeysys',
  source: 'inbound',
};

const checks: StepChecks = {
  version: 2,
  onMiss: 'FAIL',
  groups: [
    { combine: 'ANY', onMiss: 'WARN', conditions: [
      { subject: 'RESPONSE_STATUS', operator: 'EQUALS', value: '201' },
      { subject: 'RESPONSE_JSON_FIELD', name: 'journeys[*].origin', operator: 'EQUALS', value: 'CAI', items: 'ALL' },
    ] },
  ],
};

describe('ReliveChecksEditorComponent', () => {
  let fixture: ComponentFixture<ReliveChecksEditorComponent>;
  let editor: ReliveChecksEditorComponent;
  let api: jasmine.SpyObj<ReliveApiService>;
  let emitted: StepChecks[];

  beforeEach(() => {
    api = jasmine.createSpyObj('ReliveApiService', ['evaluateChecks']);
    api.evaluateChecks.and.returnValue(of({ groups: [{ passed: false, rows: [
      { holds: false, found: { values: ['200'] } },
      { holds: false, found: { fields: [{ path: 'journeys[*].origin', count: 2, values: ['CAI', 'AUH'], itemHolds: [true, false] }] } },
    ] }] }));
    TestBed.configureTestingModule({ providers: [{ provide: ReliveApiService, useValue: api }] });
    fixture = TestBed.createComponent(ReliveChecksEditorComponent);
    editor = fixture.componentInstance;
    emitted = [];
    editor.checksChange.subscribe((c) => {
      emitted.push(c);
      fixture.componentRef.setInput('checks', c);
    });
    fixture.componentRef.setInput('checks', checks);
    fixture.componentRef.setInput('recording', recording);
  });

  it('renders each group with the shared condition row, joined by OR, and its fail / warn', () => {
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelectorAll('app-condition-row').length).toBe(2);
    expect(el.querySelectorAll('.cond-and')[1].textContent!.trim()).toBe('or');
    expect(editor.onMissOf(checks.groups[0])).toBe('WARN');
    expect(editor.subjectOptions.every((o) => o.value.startsWith('RESPONSE_'))).toBeTrue();
  });

  it('asks the proxy about the recording, shortly after an edit, and shows the answer under each row', fakeAsync(() => {
    fixture.detectChanges();
    tick(500);
    fixture.detectChanges();
    const request = api.evaluateChecks.calls.mostRecent().args[0] as { answer: { status: number }; responseTimeMs: number };
    expect(request.answer.status).toBe(200);
    expect(request.responseTimeMs).toBe(1310);
    const lines = Array.from(fixture.nativeElement.querySelectorAll('.rl-check-preview') as NodeListOf<HTMLElement>).map((e) => e.textContent!.replace(/\s+/g, ' ').trim());
    expect(lines[0]).toBe('On the recording: ✗ does not hold · got 200');
    expect(lines[1]).toBe('On the recording: ✗ does not hold · journeys[*].origin: 2 items · 1 do not match');
  }));

  it('says when the preview is unavailable', fakeAsync(() => {
    api.evaluateChecks.and.returnValue(throwError(() => new Error('down')));
    fixture.detectChanges();
    tick(500);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('preview unavailable');
  }));

  it('adds a single check, an OR group, removes the last row of a group with the group', () => {
    fixture.detectChanges();
    editor.addGroup('ALL');
    editor.addGroup('ANY');
    expect(emitted.at(-1)!.groups.map((g) => g.combine)).toEqual(['ANY', 'ALL', 'ANY']);
    editor.removeCondition(2, 0);
    expect(emitted.at(-1)!.groups.length).toBe(2);
    editor.setDefault('WARN');
    expect(emitted.at(-1)!.onMiss).toBe('WARN');
    editor.setGroupOnMiss(1, 'FAIL');
    expect(emitted.at(-1)!.groups[1].onMiss).toBe('FAIL');
  });
});
