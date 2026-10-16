import { Component, input, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { CallDetailPart, CallRecord } from '../../../core/models/call.model';
import { BoardApiService } from '../../../core/services/board-api.service';
import { BoardMentionsService, MentionCallTarget } from '../../../core/services/board-mentions.service';
import { CallsApiService } from '../../../core/services/calls-api.service';
import { SessionCyclesApiService } from '../../../core/services/session-cycles-api.service';
import { CallWaterfallComponent } from '../../call-waterfall/call-waterfall.component';
import { CallFamilyService } from '../../../core/services/call-family.service';
import { CallTreeNode } from '../../../shared/utils/call-tree';
import { MentionCallPopupComponent, POPUP_OPEN_PARTS } from './mention-call-popup.component';

/** The real waterfall (Live Calls' own) is tested on its own; here it is what the popup hands it. */
@Component({ selector: 'app-call-waterfall', standalone: true,
  template: '@for (n of nodes(); track n.call.id) { <span class="fake-card">{{ n.call.method }} {{ n.call.url }} +{{ n.children.length }}</span> }' })
class FakeWaterfallComponent {
  readonly nodes = input.required<readonly CallTreeNode[]>();
  readonly depths = input<unknown>();
  readonly targetCallId = input<string | null>(null);
  readonly targetOpenParts = input<readonly CallDetailPart[]>([]);
}

const CHILD = { id: 'k1', method: 'GET', url: 'http://amadeus/v1', timestamp: '2026-10-10T09:00:00.100Z', duration_ms: 50, parentCallId: 'c1' } as unknown as CallRecord;

const CALL = { id: 'c1', method: 'POST', url: 'http://localhost:8080/orders', timestamp: '2026-10-10T09:00:00Z', service_name: 'odeysys' } as unknown as CallRecord;

describe('MentionCallPopupComponent', () => {
  let callToShow: ReturnType<typeof signal<MentionCallTarget | null>>;
  let goToCall: jasmine.Spy;
  let getSummary: jasmine.Spy;
  let listCalls: jasmine.Spy;
  let cardToOpen: ReturnType<typeof signal<unknown>>;
  let loadFamily: jasmine.Spy;

  function create() {
    callToShow = signal<MentionCallTarget | null>(null);
    cardToOpen = signal<unknown>(null);
    goToCall = jasmine.createSpy('goToCall');
    getSummary = jasmine.createSpy('getSummary').and.returnValue(of(CALL));
    loadFamily = jasmine.createSpy('load').and.callFake((c: CallRecord) => of({ root: { call: c, depth: 0, children: [{ call: CHILD, depth: 1, children: [] }] },
      calls: [c, CHILD], truncated: false }));
    listCalls = jasmine.createSpy('listCalls').and.returnValue(of({ calls: [{ id: 'x', capturedAt: '', call: CALL }], total: 1 }));
    TestBed.configureTestingModule({
      imports: [MentionCallPopupComponent],
      providers: [
        { provide: BoardMentionsService, useValue: { callToShow, cardToOpen, goToCall } },
        { provide: CallsApiService, useValue: { getSummary, getDetail: () => of({}) } },
        { provide: SessionCyclesApiService, useValue: { listCalls, getDetail: () => of({}) } },
        { provide: CallFamilyService, useValue: { load: loadFamily } },
        { provide: BoardApiService, useValue: { callBadges: () => of({ c1: [{ project: 'p', number: 5, kind: 'BUG', status: 'TO_DO', resolution: null, title: 'Orders fail' }] }) } },
      ],
    }).overrideComponent(MentionCallPopupComponent, { remove: { imports: [CallWaterfallComponent] }, add: { imports: [FakeWaterfallComponent] } });
    const fixture = TestBed.createComponent(MentionCallPopupComponent);
    fixture.detectChanges();
    return fixture;
  }

  it('shows nothing until a call is asked for', () => {
    const fixture = create();
    expect(fixture.nativeElement.querySelector('.board-call-pop')).toBeNull();
  });

  it('shows a live call as Live Calls\' waterfall with its family, its own card open with every block, and the cards that mention it', async () => {
    const fixture = create();
    callToShow.set({ direction: 'in', callId: 'c1', cycleId: null, label: 'POST /orders · 500' });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(getSummary).toHaveBeenCalledWith('c1', 'internal');
    expect(loadFamily).toHaveBeenCalledWith(CALL, null);
    expect(fixture.nativeElement.querySelector('.fake-card').textContent).toContain('POST http://localhost:8080/orders +1');
    expect(fixture.nativeElement.querySelector('.board-call-pop-sum').textContent).toContain('1 call under it · 1 level');
    const wf = fixture.debugElement.query((d) => d.componentInstance instanceof FakeWaterfallComponent).componentInstance as FakeWaterfallComponent;
    expect(wf.targetCallId()).toBe('c1');
    expect(wf.targetOpenParts()).withContext('calls under it: its card folded, so they stay in view').toEqual([]);
    expect(fixture.nativeElement.querySelector('.board-call-pop-foot').textContent).toContain('#5 Orders fail');
    expect(fixture.nativeElement.textContent).toContain('Open in Live Calls');
  });

  it('reads a call captured in a cycle from that cycle, and goes to it there', () => {
    const fixture = create();
    const target: MentionCallTarget = { direction: 'out', callId: 'c1', cycleId: 'cy', label: 'POST /orders · 500' };
    callToShow.set(target);
    fixture.detectChanges();

    expect(listCalls).toHaveBeenCalled();
    expect(listCalls.calls.mostRecent().args[0]).toBe('cy');
    expect(listCalls.calls.mostRecent().args[1].requestId).toBe('c1');
    const button = [...fixture.nativeElement.querySelectorAll('button')].find((b: HTMLButtonElement) => b.textContent!.includes('Open in its cycle')) as HTMLButtonElement;
    button.click();
    expect(goToCall).toHaveBeenCalledWith(target, 'odeysys');
  });

  it('a call with no children is still a waterfall of one line, and says so', async () => {
    const fixture = create();
    loadFamily.and.callFake((c: CallRecord) => of({ root: { call: c, depth: 0, children: [] }, calls: [c], truncated: false }));
    callToShow.set({ direction: 'in', callId: 'c1', cycleId: null, label: 'POST /orders · 500' });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.fake-card').textContent).toContain('+0');
    expect(fixture.nativeElement.querySelector('.board-call-pop-sum').textContent).toContain('no outbound calls');
    const wf = fixture.debugElement.query((d) => d.componentInstance instanceof FakeWaterfallComponent).componentInstance as FakeWaterfallComponent;
    expect(wf.targetOpenParts()).withContext('a call alone: every block open, as before').toEqual(POPUP_OPEN_PARTS);
  });

  it('says the call is gone, with its saved label and no way to go to it', () => {
    const fixture = create();
    getSummary.and.returnValue(throwError(() => new Error('404')));
    callToShow.set({ direction: 'in', callId: 'gone', cycleId: null, label: 'GET /x · 200' });
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.board-call-pop-gone').textContent).toContain('GET /x · 200');
    expect(fixture.nativeElement.textContent).not.toContain('Open in Live Calls');
  });

  it('closes on Esc without letting the board behind see the key, and on a card link opens that card', () => {
    const fixture = create();
    callToShow.set({ direction: 'in', callId: 'c1', cycleId: null, label: 'x' });
    fixture.detectChanges();
    const behind = jasmine.createSpy('behind');
    document.addEventListener('keydown', behind);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    document.removeEventListener('keydown', behind);
    expect(callToShow()).toBeNull();
    expect(behind).not.toHaveBeenCalled();

    callToShow.set({ direction: 'in', callId: 'c1', cycleId: null, label: 'x' });
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.board-call-pop-foot .board-link') as HTMLButtonElement).click();
    expect(cardToOpen()).toEqual({ project: 'p', number: 5 });
    expect(callToShow()).toBeNull();
  });
});
