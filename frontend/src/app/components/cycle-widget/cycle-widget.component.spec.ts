import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { computed, signal } from '@angular/core';
import { Subject, of } from 'rxjs';
import { CycleWidgetComponent, relativeTime } from './cycle-widget.component';
import { CycleWidgetStateService, WidgetArrival, WidgetSource } from '../../core/state/cycle-widget-state.service';
import { CycleWidgetWindowService } from '../../core/services/cycle-widget-window.service';
import { CallRecord, SessionCycle } from '../../core/models/call.model';

function call(id: string, overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    id,
    original_url: `https://api.example.com/${id}`,
    url: `https://api.example.com/${id}`,
    method: 'GET',
    timestamp: '2026-09-27T10:00:00.000Z',
    duration_ms: 12,
    response: { status: 200 } as CallRecord['response'],
    source: 'external',
    ...overrides,
  };
}

describe('relativeTime', () => {
  it('words an age the way the minimized summary reads it', () => {
    expect(relativeTime(20_000)).toBe('just now');
    expect(relativeTime(3 * 60_000)).toBe('3 min ago');
    expect(relativeTime(2 * 3_600_000)).toBe('2 h ago');
    expect(relativeTime(26 * 3_600_000)).toBe('1 day ago');
  });
});

describe('CycleWidgetComponent', () => {
  let fixture: ComponentFixture<CycleWidgetComponent>;
  let arrivals: Subject<WidgetArrival>;
  let selected: ReturnType<typeof signal<SessionCycle | null>>;
  let state: Record<string, unknown>;
  let seq = 0;
  let winStub: { collapsed: ReturnType<typeof signal<boolean>>; fitCollapsedHeight: jasmine.Spy; setCollapsed: jasmine.Spy; setPinned: jasmine.Spy };

  function arrive(c: CallRecord, isNew = true): void {
    arrivals.next({ call: c, isNew, seq: ++seq });
    fixture.detectChanges();
  }

  function toastText(): string {
    return (fixture.nativeElement.querySelector('.cw-toast') as HTMLElement).textContent ?? '';
  }

  function toastVisible(): boolean {
    return fixture.nativeElement.querySelector('.cw-toast').classList.contains('on');
  }

  beforeEach(() => {
    arrivals = new Subject<WidgetArrival>();
    selected = signal<SessionCycle | null>({ id: 'c1', name: 'Checkout flow', createdAt: '2026-09-27T00:00:00Z', assignedTo: null, status: 'RECORDING' });
    const calls = signal<readonly CallRecord[]>([]);
    const sources = signal<readonly WidgetSource[]>([
      { key: 'external', label: 'Outbound', direction: 'outbound', loggingEnabled: null },
      { key: 'core-service', label: 'core-service', direction: 'inbound', loggingEnabled: false },
    ]);
    const hidden = signal<ReadonlySet<string>>(new Set());
    state = {
      arrivals$: arrivals,
      selectedCycle: selected,
      cycles: computed(() => (selected() ? [selected()!] : [])),
      selectedIndex: signal(0),
      calls,
      visibleCalls: calls,
      loading: signal(false),
      error: signal<string | null>(null),
      sources,
      hiddenSources: hidden,
      tree: signal([]),
      depths: signal(new Map()),
      isSourceVisible: (key: string) => !hidden().has(key),
      toggleRecording: jasmine.createSpy('toggleRecording').and.returnValue(of(null)),
      createAndRecord: jasmine.createSpy('createAndRecord').and.returnValue(of(selected())),
      setLogging: jasmine.createSpy('setLogging'),
      select: jasmine.createSpy('select'),
      showOptionsCalls: signal(false),
      setShowOptionsCalls: jasmine.createSpy('setShowOptionsCalls'),
      spacers: signal([]),
      callOrder: signal('oldest'),
      cycleSort: signal('newest'),
      latestAnchor: signal({ afterCallId: 'last', anchorTimestamp: '2026-09-27T10:00:00.000Z' }),
      setCycleSort: jasmine.createSpy('setCycleSort'),
      setCallOrder: jasmine.createSpy('setCallOrder'),
      addSpacer: jasmine.createSpy('addSpacer').and.returnValue(of({ id: 's', label: 'x' })),
      renameSpacer: jasmine.createSpy('renameSpacer'),
      deleteSpacer: jasmine.createSpy('deleteSpacer'),
      activate: jasmine.createSpy('activate'),
      deactivate: jasmine.createSpy('deactivate'),
    };
    const win = {
      collapsed: signal(false),
      pipSupported: true,
      mode: signal('pip'),
      pinned: signal(true),
      notice: signal<string | null>(null),
      setPinned: jasmine.createSpy('setPinned').and.resolveTo(),
      setCollapsed: jasmine.createSpy('setCollapsed'),
      showInAlfred: jasmine.createSpy('showInAlfred'),
      fitCollapsedHeight: jasmine.createSpy('fitCollapsedHeight'),
      recording: signal(false),
    };
    winStub = win;
    TestBed.configureTestingModule({
      imports: [CycleWidgetComponent],
      providers: [
        { provide: CycleWidgetStateService, useValue: state },
        { provide: CycleWidgetWindowService, useValue: win },
      ],
    });
    fixture = TestBed.createComponent(CycleWidgetComponent);
    fixture.detectChanges();
  });

  it('pops a toast for a new call and hides it after a few seconds', fakeAsync(() => {
    arrive(call('orders'));
    expect(toastVisible()).toBeTrue();
    expect(toastText()).toContain('api.example.com/orders');
    expect(toastText()).toContain('new root call');

    tick(3600);
    fixture.detectChanges();
    expect(toastVisible()).toBeFalse();
  }));

  it('folds a burst into one toast with a "+N more" count', fakeAsync(() => {
    arrive(call('a'));
    arrive(call('b'));
    arrive(call('c'));
    expect(toastText()).toContain('api.example.com/c');
    expect(toastText()).toContain('+2 more');
    tick(4000);
  }));

  it('fills in the status when the in-progress call on the toast resolves', fakeAsync(() => {
    arrive(call('slow', { state: 'IN_PROGRESS', response: undefined }));
    expect(toastText()).toContain('…');
    arrive(call('slow'), false);
    expect(toastText()).toContain('200');
    expect(toastText()).not.toContain('+1 more');
    tick(4000);
  }));

  it('validates the new-cycle name before creating', () => {
    fixture.componentInstance.togglePillPanel('new');
    fixture.detectChanges();
    fixture.componentInstance.createCycle();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.cw-error').textContent).toContain('Enter a cycle name');
    expect(state['createAndRecord']).not.toHaveBeenCalled();

    fixture.componentInstance.onNameInput('Retry flow');
    fixture.componentInstance.createCycle();
    expect(state['createAndRecord']).toHaveBeenCalledWith('Retry flow');
  });

  it('marks a project whose inbound logging is off, and flips its switch through the state', () => {
    fixture.componentInstance.toggleSourcesPanel();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('1 muted');
    expect(fixture.nativeElement.querySelector('.cw-sources').textContent).toContain('not logging');

    const toggle = fixture.nativeElement.querySelector('.cw-switch') as HTMLButtonElement;
    toggle.click();
    expect(state['setLogging']).toHaveBeenCalledWith('core-service', true);
  });

  it('tells the side tab in the Alfred tab whether its cycle is recording', () => {
    const recording = (TestBed.inject(CycleWidgetWindowService) as unknown as { recording: ReturnType<typeof signal<boolean>> }).recording;
    expect(recording()).toBeTrue();
    selected.set({ ...selected()!, status: 'PAUSED' });
    fixture.detectChanges();
    expect(recording()).toBeFalse();
  });

  it('runs the widget state only while it is on screen', () => {
    expect(state['activate']).toHaveBeenCalled();
    fixture.destroy();
    expect(state['deactivate']).toHaveBeenCalled();
  });

  describe('collapsed pill', () => {
    function collapse(): void {
      winStub.collapsed.set(true);
      fixture.detectChanges();
    }

    function el(selector: string): HTMLElement | null {
      return fixture.nativeElement.querySelector(selector);
    }

    it('opens the cycle list under the pill and closes it once a cycle is picked', () => {
      collapse();
      el('.cw-pill-name')!.click();
      fixture.detectChanges();
      expect(el('.cw-pill-panel .cw-list')).not.toBeNull();

      el('.cw-pill-panel .cw-list-item')!.click();
      fixture.detectChanges();
      expect(state['select']).toHaveBeenCalledWith('c1');
      expect(el('.cw-pill-panel')).toBeNull();
    });

    it('creates a cycle from the pill, validating the name first', () => {
      collapse();
      el('.cw-pill button[aria-label="New cycle"]')!.click();
      fixture.detectChanges();
      el('.cw-pill-panel button[type="submit"]')!.click();
      fixture.detectChanges();
      expect(el('.cw-pill-panel .cw-error')!.textContent).toContain('Enter a cycle name');

      fixture.componentInstance.onNameInput('From the pill');
      el('.cw-pill-panel button[type="submit"]')!.click();
      fixture.detectChanges();
      expect(state['createAndRecord']).toHaveBeenCalledWith('From the pill');
      expect(el('.cw-pill-panel')).toBeNull();
    });

    it('fits the window to what is open under the pill', async () => {
      collapse();
      await fixture.whenStable();
      winStub.fitCollapsedHeight.calls.reset();
      fixture.componentInstance.togglePillPanel('list');
      fixture.detectChanges();
      await fixture.whenStable();
      expect(winStub.fitCollapsedHeight).toHaveBeenCalled();
    });

    it('adds a spacer after the latest call from the pill, and says so in the status line', fakeAsync(() => {
      collapse();
      el('.cw-pill button[aria-label="Add spacer"]')!.click();
      fixture.detectChanges();
      el('.cw-pill-panel button[type="submit"]')!.click();
      fixture.detectChanges();
      expect(el('.cw-pill-panel .cw-error')!.textContent).toContain('Enter a spacer label');

      (el('.cw-pill-panel input') as HTMLInputElement).value = 'Step 2';
      el('.cw-pill-panel button[type="submit"]')!.click();
      fixture.detectChanges();
      expect(state['addSpacer']).toHaveBeenCalledWith('Step 2', { afterCallId: 'last', anchorTimestamp: '2026-09-27T10:00:00.000Z' });
      expect(el('.cw-pill-panel')).toBeNull();
      expect(el('.cw-pill-idle')!.textContent).toContain('Spacer "Step 2" added');
      tick(2600);
    }));

    it('sorts the cycle list from the list itself', () => {
      collapse();
      el('.cw-pill-name')!.click();
      fixture.detectChanges();
      const byName = [...fixture.nativeElement.querySelectorAll('.cw-list-sort button')].find((b: Element) => b.textContent!.trim() === 'Name') as HTMLButtonElement;
      byName.click();
      expect(state['setCycleSort']).toHaveBeenCalledWith('name');
    });

    it('groups the header: cycles on the left, this recording in the middle, the window at the end', () => {
      collapse();
      const labels = [...fixture.nativeElement.querySelectorAll('.cw-pill > button')].map((b: Element) => b.getAttribute('aria-label') ?? 'cycle');
      expect(labels).toEqual(['cycle', 'New cycle', 'Add spacer', 'Pause recording', 'Stop keeping on top', 'Expand']);
      // New cycle and Add spacer are no longer neighbours - the flexible gap sits between them.
      const newCycle = el('.cw-pill button[aria-label="New cycle"]')!;
      expect(newCycle.nextElementSibling!.classList).toContain('cw-spacer');
      expect(el('.cw-pill .cw-pill-divider')).not.toBeNull();
    });

    it('keeps the keep-on-top button in the pill', () => {
      collapse();
      const pin = el('.cw-pill button[aria-label="Stop keeping on top"]') as HTMLButtonElement;
      expect(pin).not.toBeNull();
      pin.click();
      expect(winStub.setPinned).toHaveBeenCalledWith(false);
    });

    it('shows the new-call notification under the controls, counting a burst', fakeAsync(() => {
      collapse();
      arrive(call('a'));
      arrive(call('b'));
      expect(el('.cw-pill .cw-pill-note')).toBeNull();
      expect(el('.cw-pill-status .cw-pill-note')!.textContent).toContain('api.example.com/b');
      expect(el('.cw-pill-idle')!.classList).toContain('hidden');
      expect(el('.cw-pill-more')!.textContent).toContain('+1');

      tick(3600);
      fixture.detectChanges();
      expect(el('.cw-pill-note')).toBeNull();
    }));

    it('holds the pill notification while hovered, and opens the widget when clicked', fakeAsync(() => {
      collapse();
      arrive(call('a'));
      el('.cw-pill-note')!.dispatchEvent(new Event('mouseenter'));
      tick(5000);
      fixture.detectChanges();
      expect(el('.cw-pill-note')).not.toBeNull();

      el('.cw-pill-note')!.click();
      expect(winStub.setCollapsed).toHaveBeenCalledWith(false);
    }));

    it('shows a quiet summary under the controls when nothing is arriving', () => {
      (state['calls'] as ReturnType<typeof signal<readonly CallRecord[]>>).set([
        call('a', { timestamp: new Date(Date.now() - 5 * 60_000).toISOString() }),
        call('b', { timestamp: new Date(Date.now() - 150_000).toISOString() }),
      ]);
      collapse();
      expect(el('.cw-pill-idle')!.textContent!.trim()).toBe('Recording · 2 calls · last 2 min ago');
    });

    it('shows a warning under the pill, dismissable', () => {
      collapse();
      (winStub as unknown as { notice: ReturnType<typeof signal<string | null>> }).notice.set('Click "Pin on top" in the Alfred tab to pin the widget.');
      fixture.detectChanges();
      expect(el('.cw-pill-notice')!.textContent).toContain('Pin on top');
      (el('.cw-pill-notice button') as HTMLButtonElement).click();
      fixture.detectChanges();
      expect(el('.cw-pill-notice')).toBeNull();
    });

    it('shows Resume as a round button on a paused cycle', () => {
      selected.set({ ...selected()!, status: 'PAUSED' });
      collapse();
      const resume = el('.cw-rec-btn') as HTMLButtonElement;
      expect(resume.getAttribute('aria-label')).toBe('Resume recording');
      resume.click();
      expect(state['toggleRecording']).toHaveBeenCalled();
    });

    it('closes whatever is open when expanding', () => {
      collapse();
      fixture.componentInstance.togglePillPanel('new');
      fixture.componentInstance.expand();
      expect(fixture.componentInstance.pillPanel()).toBeNull();
      expect(winStub.setCollapsed).toHaveBeenCalledWith(false);
    });
  });

  describe('Windows notifications', () => {
    let shown: { title: string; body?: string }[];
    let original: PropertyDescriptor | undefined;

    beforeEach(() => {
      shown = [];
      original = Object.getOwnPropertyDescriptor(window, 'Notification');
      class FakeNotification {
        static permission = 'granted';
        static requestPermission = () => Promise.resolve('granted');
        onclick: (() => void) | null = null;
        constructor(title: string, options?: { body?: string }) {
          shown.push({ title, body: options?.body });
        }
      }
      Object.defineProperty(window, 'Notification', { value: FakeNotification, configurable: true, writable: true });
      localStorage.setItem('alfred-cycle-widget-os-notify', 'true');
      // Rebuilt so the component reads the fake at construction.
      fixture.destroy();
      fixture = TestBed.createComponent(CycleWidgetComponent);
      fixture.detectChanges();
      spyOn(document, 'hasFocus').and.returnValue(false);
    });

    afterEach(() => {
      localStorage.removeItem('alfred-cycle-widget-os-notify');
      if (original) Object.defineProperty(window, 'Notification', original);
    });

    it('groups a burst into one notification naming the cycle', fakeAsync(() => {
      arrive(call('a'));
      arrive(call('b'));
      arrive(call('c'));
      tick(1300);
      expect(shown.length).toBe(1);
      expect(shown[0].title).toBe('3 new calls in Checkout flow');
      tick(4000);
    }));

    it('sends nothing while the widget itself has focus', fakeAsync(() => {
      (document.hasFocus as jasmine.Spy).and.returnValue(true);
      arrive(call('a'));
      tick(1300);
      expect(shown).toEqual([]);
      tick(4000);
    }));

    it('can be switched off', fakeAsync(() => {
      void fixture.componentInstance.toggleOsNotify();
      arrive(call('a'));
      tick(1300);
      expect(shown).toEqual([]);
      tick(4000);
    }));
  });

  it('minimizes at once, closing anything open under the header', () => {
    fixture.componentInstance.togglePillPanel('list');
    fixture.componentInstance.collapse();
    expect(winStub.setCollapsed).toHaveBeenCalledWith(true);
    expect(fixture.componentInstance.pillPanel()).toBeNull();
  });

  it('has one header - no separate title bar - with pin and minimize when expanded', () => {
    expect(fixture.nativeElement.querySelector('.cw-titlebar')).toBeNull();
    expect(fixture.nativeElement.querySelector('.cw-pill button[aria-label="Stop keeping on top"]')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.cw-pill button[aria-label="Minimize"]')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.cw-pill button[aria-label="Expand"]')).toBeNull();
  });

  it('offers Resume on a paused cycle', () => {
    selected.set({ ...selected()!, status: 'PAUSED' });
    fixture.detectChanges();
    const button = fixture.nativeElement.querySelector('.cw-toggle') as HTMLButtonElement;
    expect(button.textContent).toContain('Resume');
    button.click();
    expect(state['toggleRecording']).toHaveBeenCalled();
  });
});
