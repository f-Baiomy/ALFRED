import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { CallFocusService, RevealableList } from './call-focus.service';

function list(selected: string[], showOptions = false): RevealableList & { toggleSource: jasmine.Spy; toggleShowOptionsCalls: jasmine.Spy } {
  return {
    selectedSources: () => new Set(selected),
    toggleSource: jasmine.createSpy('toggleSource'),
    showOptionsCalls: () => showOptions,
    toggleShowOptionsCalls: jasmine.createSpy('toggleShowOptionsCalls'),
  };
}

describe('CallFocusService reveal', () => {
  let service: CallFocusService;
  let router: Router;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    service = TestBed.inject(CallFocusService);
    router = TestBed.inject(Router);
    spyOn(router, 'navigate').and.resolveTo(true);
  });

  it('opens the cycle with ?reveal= - not the ?requestId= filter, so every call stays listed', () => {
    service.revealIn({ callId: 'x', cycleId: 'c1', direction: 'outbound', serviceName: null, preflight: false });
    expect(router.navigate).toHaveBeenCalledWith(['/cycles', 'c1'], { queryParams: { reveal: 'x' } });
    expect(service.reveal()).toBe('x');
  });

  it('switches on the call\'s source and shows OPTIONS when the call is a preflight', () => {
    service.revealIn({ callId: 'x', cycleId: 'c1', direction: 'inbound', serviceName: 'odeysys', preflight: true });
    const page = list(['external']);
    service.applyReveal(page, 'c1', 'x');
    expect(page.toggleSource).toHaveBeenCalledWith('odeysys');
    expect(page.toggleShowOptionsCalls).toHaveBeenCalled();
  });

  it('leaves the page alone when the source is already showing', () => {
    service.revealIn({ callId: 'x', cycleId: 'c1', direction: 'outbound', serviceName: null, preflight: false });
    const page = list(['external']);
    service.applyReveal(page, 'c1', 'x');
    expect(page.toggleSource).not.toHaveBeenCalled();
    expect(page.toggleShowOptionsCalls).not.toHaveBeenCalled();
  });

  it('still points for a bare ?reveal= link, and clears once pointed', () => {
    const page = list([]);
    service.applyReveal(page, 'c1', 'y');
    expect(service.reveal()).toBe('y');
    expect(page.toggleSource).not.toHaveBeenCalled();
    service.revealed('y');
    expect(service.reveal()).toBeNull();
  });
});

describe('CallFocusService go', () => {
  it('clears a leftover text search so the call asked for is not hidden by it - only for its own focus', () => {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    const service = TestBed.inject(CallFocusService);
    spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
    const page = {
      selectedSources: () => new Set(['external']),
      toggleSource: jasmine.createSpy('toggleSource'),
      setRequestIdFilter: jasmine.createSpy('setRequestIdFilter'),
      setSearchQuery: jasmine.createSpy('setSearchQuery'),
    };

    service.applyTo(page, null, 'abc'); // a plain ?requestId= link keeps the user's search
    expect(page.setSearchQuery).not.toHaveBeenCalled();

    service.go({ callId: 'out-54', cycleId: null, direction: 'outbound', serviceName: null });
    service.applyTo(page, null, 'out-54');
    expect(page.setSearchQuery).toHaveBeenCalledWith('');
    expect(page.setRequestIdFilter).toHaveBeenCalledWith('out-54');
  });
});
