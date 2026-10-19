import { TestBed, fakeAsync, tick } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { AzureEvidenceService } from '../../../core/team/azure-evidence.service';
import { TeamApiService } from '../../../core/team/team-api.service';
import { TeamStateService } from '../../../core/team/team-state.service';
import { BundleCheck, WriteBundle } from '../../../core/team/team.models';
import { TeamConsentBundleComponent, UNDO_SECONDS } from './consent-bundle.component';

const BUNDLE: WriteBundle = {
  id: 7, boardId: 'b1', cardId: 'k72', conn: 'c1', item: '62123', origin: 'CLAUDE', askedIn: '5261', title: 'Tell Azure', state: 'WAITING',
  createdAt: new Date().toISOString(), decidedAt: null, decidedBy: null,
  steps: [
    { kind: 'STATE', payload: { state: 'Testing', from: 'New' }, ticked: true, unmasked: false },
    { kind: 'COMMENT', payload: { text: 'Deployed to staging 216 (build 3.4.7) and ready', draft: 'Deployed to Staging 216 and ready' }, ticked: true, unmasked: false },
  ],
};

describe('TeamConsentBundleComponent (specs/034)', () => {
  let api: jasmine.SpyObj<TeamApiService>;

  function make(check: BundleCheck | null, bundle: WriteBundle = BUNDLE) {
    api = jasmine.createSpyObj<TeamApiService>('TeamApiService', ['checkBundle', 'editBundle', 'approve', 'reject', 'askRedraft', 'retryStep', 'bundleFile']);
    api.checkBundle.and.returnValue(of(check as BundleCheck));
    api.editBundle.and.callFake((_id, body) => of({ ...bundle, steps: body.steps }));
    api.approve.and.returnValue(of({ ...bundle, state: 'DONE' }));
    api.reject.and.returnValue(of({ ...bundle, state: 'REJECTED' }));
    api.askRedraft.and.returnValue(of({ message: 9 }));
    api.retryStep.and.returnValue(of({ ...bundle, state: 'DONE' }));
    TestBed.configureTestingModule({
      imports: [TeamConsentBundleComponent],
      providers: [
        provideRouter([]),
        { provide: TeamApiService, useValue: api },
        { provide: AzureEvidenceService, useValue: {} },
        { provide: TeamStateService, useValue: { hasToken: signal(true), connections: signal([{ id: 'c1', kind: 'azure', baseUrl: 'https://dev.azure.com/org' }]) } },
      ],
    });
    const f = TestBed.createComponent(TeamConsentBundleComponent);
    f.componentRef.setInput('bundle', bundle);
    f.detectChanges();
    f.detectChanges();
    return f;
  }

  it('reads every change as old -> new and marks what the user changed in Claude\'s draft', () => {
    const f = make({ id: 7, itemState: 'New', changedBy: null, changedAt: null, footer: '\n\n_via Alfred_',
      steps: [{ step: 0, now: 'New', allowed: null, changed: false, refused: false }] });
    const el: HTMLElement = f.nativeElement;
    expect(el.querySelector('.tcb-old')?.textContent).toBe('New');
    expect(el.querySelector('.tcb-new')?.textContent).toBe('Testing');
    expect(el.querySelector('.tcb-edited')?.textContent).toContain('edited by you');
    expect(Array.from(el.querySelectorAll('.tcb-d-ins')).map((e) => e.textContent).join('')).toContain('(build 3.4.7)');
    expect(el.querySelector('.tcb-d-del')?.textContent).toContain('Staging');
    expect(el.querySelector('a.board-link')?.getAttribute('href')).toBe('https://dev.azure.com/org/_workitems/edit/62123');
  });

  it('says when Azure moved the item since, and leaves out a move Azure would refuse', () => {
    const f = make({ id: 7, itemState: 'Active', changedBy: 'Mostafa Negm', changedAt: '2026-10-18T20:29:00Z', footer: '',
      steps: [{ step: 0, now: 'Active', allowed: ['Resolved', 'New'], changed: true, refused: true }] });
    const el: HTMLElement = f.nativeElement;
    expect(el.textContent).toContain('Azure says Active now');
    expect(el.textContent).toContain('does not allow Active → Testing');
    const c = f.componentInstance;
    expect(c.steps()[0].ticked).toBeFalse();
    expect(c.ticked()).toBe(1);
    c.pickState(0, 'Resolved');
    expect(c.steps()[0]).toEqual(jasmine.objectContaining({ ticked: true, payload: jasmine.objectContaining({ state: 'Resolved' }) }));
  });

  it('sends only after the Undo time, and Undo keeps it waiting', fakeAsync(() => {
    const f = make(null);
    const c = f.componentInstance;
    c.approve();
    expect(c.counting()).toBe(UNDO_SECONDS);
    tick(2000);
    c.undo();
    tick(UNDO_SECONDS * 1000);
    expect(api.approve).not.toHaveBeenCalled();
    c.approve();
    tick(UNDO_SECONDS * 1000);
    expect(api.approve).toHaveBeenCalledOnceWith(7);
  }));

  it('rejects with the reason, asks Claude for a redraft, and retries a failed step', () => {
    const f = make(null);
    const c = f.componentInstance;
    c.rejecting.set(true);
    c.reason.set('wrong env');
    c.reject();
    expect(api.reject).toHaveBeenCalledWith(7, 'wrong env');
    c.setAsk(1, 'shorter');
    c.redraft(1);
    expect(api.askRedraft).toHaveBeenCalledWith(7, 1, 'shorter');
    c.retry(0);
    expect(api.retryStep).toHaveBeenCalledWith(7, 0);
  });
});
