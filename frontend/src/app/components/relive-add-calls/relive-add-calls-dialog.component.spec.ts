import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { CallRecord } from '../../core/models/call.model';
import { ReliveCallSourceService } from '../../core/services/relive-call-source.service';
import { SessionCyclesStateService } from '../../core/state/session-cycles-state.service';
import { ReliveSettings, Step } from '../../shared/utils/relive-types';
import { modeOf, reachesHost } from '../../shared/utils/relive-call-rule';
import { ReliveAddCallsDialogComponent } from './relive-add-calls-dialog.component';

const settings: ReliveSettings = { inboundMode: 'LIVE', onFailure: 'HOLD', onDifferences: 'CONTINUE', defaultDriver: 'AUTOMATIC', internalHosts: [] };
const root: CallRecord = {
  id: 'in', original_url: 'http://app/search', url: 'http://app/search', method: 'POST',
  timestamp: '2026-01-01T00:00:00.000Z', duration_ms: 1000, source: 'internal',
  service_name: 'app', response: { status: 200 }, state: 'COMPLETED',
};
const child: CallRecord = {
  ...root, id: 'out', original_url: 'http://supplier/search', url: 'http://supplier/search',
  timestamp: '2026-01-01T00:00:00.100Z', duration_ms: 100, source: 'external', response: { status: 200 },
};

describe('ReliveAddCallsDialogComponent', () => {
  let fixture: ComponentFixture<ReliveAddCallsDialogComponent>;
  let source: jasmine.SpyObj<ReliveCallSourceService>;

  beforeEach(() => {
    source = jasmine.createSpyObj<ReliveCallSourceService>('ReliveCallSourceService', ['loadCycle', 'hydrate']);
    source.loadCycle.and.resolveTo([root, child]);
    source.hydrate.and.resolveTo([
      { ...root, request: { headers: { 'X-App': 'yes' }, body: '{"q":1}' }, response: { status: 200, headers: {}, body: 'ok' } },
      { ...child, request: { headers: {}, body: '{"supplier":1}' }, response: { status: 201, headers: { 'X-Supplier': 'yes' }, body: '{"id":2}' } },
    ]);
    TestBed.configureTestingModule({
      imports: [ReliveAddCallsDialogComponent],
      providers: [provideRouter([]), { provide: ReliveCallSourceService, useValue: source }, { provide: SessionCyclesStateService, useValue: { cycles: () => [] } }],
    });
    fixture = TestBed.createComponent(ReliveAddCallsDialogComponent);
    fixture.componentRef.setInput('open', true);
    fixture.componentRef.setInput('cycleId', 'c-1');
    fixture.componentRef.setInput('settings', settings);
    fixture.detectChanges();
  });

  it('shows the inbound root and indented outbound child', async () => {
    await fixture.componentInstance.selectSessionCycle('sc-1');
    fixture.detectChanges();
    expect(fixture.componentInstance.tree().length).toBe(1);
    expect(fixture.componentInstance.isChecked('in')).toBeTrue();
    expect(fixture.componentInstance.tree()[0].children[0].call.id).toBe('out');
    expect(fixture.nativeElement.textContent).toContain('outbound child call');
    expect(fixture.nativeElement.textContent).toContain('supplier/search');
  });

  it('selects every root by default and supports select all and deselect all', async () => {
    const second = { ...root, id: 'in-2', url: 'http://app/price', timestamp: '2026-01-01T00:00:02.000Z' };
    source.loadCycle.and.resolveTo([root, child, second]);
    await fixture.componentInstance.selectSessionCycle('sc-1');
    fixture.detectChanges();
    expect(fixture.componentInstance.checkedRootIds().size).toBe(2);
    const buttons: HTMLButtonElement[] = [...fixture.nativeElement.querySelectorAll('.relive-add-selection-actions button')];
    buttons[1].click();
    expect(fixture.componentInstance.checkedRootIds().size).toBe(0);
    buttons[0].click();
    expect(fixture.componentInstance.checkedRootIds().size).toBe(2);
  });

  it('keeps long call URLs inside the dialog width', async () => {
    source.loadCycle.and.resolveTo([{ ...root, url: `http://app/${'very-long-segment-'.repeat(35)}` }]);
    await fixture.componentInstance.selectSessionCycle('sc-1');
    fixture.detectChanges();
    const dialog: HTMLElement = fixture.nativeElement.querySelector('.relive-add-dialog');
    expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth);
  });

  it('hydrates root and child before freezing the full recorded replay answer', async () => {
    await fixture.componentInstance.selectSessionCycle('sc-1');
    let emitted: readonly Step[] = [];
    fixture.componentInstance.added.subscribe((steps) => emitted = steps);
    await fixture.componentInstance.confirm();
    expect(source.hydrate).toHaveBeenCalledWith([root, child], 'sc-1');
    expect(emitted.length).toBe(2);
    expect(emitted[1].parentKey).toBe(emitted[0].key);
    expect(emitted[1].recording.responseBody).toBe('{"id":2}');
    expect(emitted[1].recording.responseHeaders['X-Supplier']).toBe('yes');
    expect(emitted[1].source.cycleId).toBe('sc-1');
    expect(modeOf(emitted[1].callRule)).toBe('REPLAY');
    expect(reachesHost(emitted[1].callRule).reaches).toBeFalse();
    expect(emitted[1].callRule.actions.find((action) => action.type === 'MOCK_RESPONSE')?.body).toBe('{"id":2}');
  });

  it('keeps the selection open when detail loading fails', async () => {
    source.hydrate.and.rejectWith(new Error('network'));
    await fixture.componentInstance.selectSessionCycle('sc-1');
    const closed = jasmine.createSpy('closed');
    fixture.componentInstance.closed.subscribe(closed);
    await fixture.componentInstance.confirm();
    expect(closed).not.toHaveBeenCalled();
    expect(fixture.componentInstance.checkedRootIds().has('in')).toBeTrue();
    expect(fixture.componentInstance.error()).toContain('Could not load full call details');
  });
});
