import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { CycleWidgetWindowService } from './cycle-widget-window.service';

/**
 * The window plumbing only - which kind of window opens, the fallbacks, and the notices. Mounting
 * into a real PiP/popup can't run headless; openIn's rendering path is replaced with a stub here.
 */
describe('CycleWidgetWindowService', () => {

  /** Chrome defines documentPictureInPicture as a getter - shadow it with an own property per test. */
  function setPip(value: unknown): void {
    Object.defineProperty(window, 'documentPictureInPicture', { value, configurable: true, writable: true });
  }

  function create(pip: { requestWindow: jasmine.Spy } | undefined): CycleWidgetWindowService {
    setPip(pip);
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    const service = TestBed.inject(CycleWidgetWindowService);
    // The real DOM work (style cloning, mounting the component) is not what these tests are about.
    const internals = service as unknown as { prepareDocument(w: Window): void; mount(w: Window): Promise<void> };
    spyOn(internals, 'prepareDocument');
    spyOn(internals, 'mount').and.resolveTo();
    return service;
  }

  function fakeWindow(): Window {
    return {
      closed: false,
      innerWidth: 420,
      innerHeight: 79,
      close: jasmine.createSpy('close'),
      focus: jasmine.createSpy('focus'),
      resizeBy: jasmine.createSpy('resizeBy'),
      addEventListener() {},
      removeEventListener() {},
    } as unknown as Window;
  }

  afterEach(() => {
    delete (window as unknown as { documentPictureInPicture?: unknown }).documentPictureInPicture;
  });

  it('opens an always-on-top PiP window by default where the browser supports it', async () => {
    const pipWindow = fakeWindow();
    const service = create({ requestWindow: jasmine.createSpy('requestWindow').and.resolveTo(pipWindow) });
    await service.open();
    expect(service.mode()).toBe('pip');
    expect(service.isOpen()).toBeTrue();
  });

  it('falls back to a normal window, and says so, when the browser refuses PiP', async () => {
    const popup = fakeWindow();
    const service = create({ requestWindow: jasmine.createSpy('requestWindow').and.rejectWith(new Error('NotAllowedError')) });
    spyOn(window, 'open').and.returnValue(popup);
    spyOn(console, 'warn');
    await service.open();
    expect(service.mode()).toBe('popup');
    expect(service.notice()).toContain('opened as a normal window');
  });

  it('opens a popup where PiP does not exist at all', async () => {
    const service = create(undefined);
    spyOn(window, 'open').and.returnValue(fakeWindow());
    await service.open();
    expect(service.pipSupported).toBeFalse();
    expect(service.mode()).toBe('popup');
  });

  it('explains a blocked popup instead of failing silently', async () => {
    const service = create(undefined);
    spyOn(window, 'open').and.returnValue(null);
    await service.open();
    expect(service.isOpen()).toBeFalse();
    expect(service.notice()).toContain('blocked');
  });

  it('unpinning moves the widget to a popup, opening the new window before closing the old one', async () => {
    const pipWindow = fakeWindow();
    const popup = fakeWindow();
    const service = create({ requestWindow: jasmine.createSpy('requestWindow').and.resolveTo(pipWindow) });
    await service.open();
    const openSpy = spyOn(window, 'open').and.callFake(() => {
      expect(pipWindow.close).not.toHaveBeenCalled();
      return popup;
    });

    await service.setPinned(false);

    expect(openSpy).toHaveBeenCalled();
    expect(pipWindow.close).toHaveBeenCalled();
    expect(service.mode()).toBe('popup');
    expect(service.pinned()).toBeFalse();
    // Moving between windows is not closing the widget.
    expect(service.isOpen()).toBeTrue();
  });

  it('always opens pinned, even after the last window was unpinned', async () => {
    const requestWindow = jasmine.createSpy('requestWindow').and.callFake(() => Promise.resolve(fakeWindow()));
    const service = create({ requestWindow });
    spyOn(window, 'open').and.returnValue(fakeWindow());
    await service.open();
    await service.setPinned(false);
    expect(service.mode()).toBe('popup');

    service.close();
    await service.open();
    expect(service.mode()).toBe('pip');
  });

  /** Opens pinned, unpins to a popup, then makes Chrome refuse PiP - as it does for a click in the popup. */
  async function unpinnedWithPipRefused(): Promise<{ service: CycleWidgetWindowService; popup: Window; requestWindow: jasmine.Spy }> {
    const popup = fakeWindow();
    const requestWindow = jasmine.createSpy('requestWindow').and.resolveTo(fakeWindow());
    const service = create({ requestWindow });
    spyOn(window, 'open').and.returnValue(popup);
    spyOn(window, 'focus');
    spyOn(console, 'warn');
    await service.open();
    await service.setPinned(false);
    requestWindow.and.rejectWith(new Error('NotAllowedError'));
    return { service, popup, requestWindow };
  }

  it('hands a refused re-pin to the launcher in the Alfred tab instead of failing silently', async () => {
    const { service, popup } = await unpinnedWithPipRefused();

    await service.setPinned(true);

    expect(service.mode()).toBe('popup');
    expect(popup.close).not.toHaveBeenCalled();
    expect(service.repinRequested()).toBeTrue();
    expect(service.notice()).toContain('Pin on top');
    expect(window.focus).toHaveBeenCalled();
  });

  it('the launcher click then pins the widget and closes the popup', async () => {
    const { service, popup, requestWindow } = await unpinnedWithPipRefused();
    await service.setPinned(true);

    requestWindow.and.resolveTo(fakeWindow());
    await service.open();

    expect(service.mode()).toBe('pip');
    expect(popup.close).toHaveBeenCalled();
    expect(service.repinRequested()).toBeFalse();
  });

  it('always opens minimized, asking Chrome for the requested size and no back-to-tab button', async () => {
    const requestWindow = jasmine.createSpy('requestWindow').and.resolveTo(fakeWindow());
    const service = create({ requestWindow });
    service.setCollapsed(false);
    await service.open();
    expect(service.collapsed()).toBeTrue();
    expect(requestWindow).toHaveBeenCalledWith({ width: 420, height: 79, disallowReturnToOpener: true, preferInitialWindowPlacement: true });
  });

  it('grows the collapsed window by the difference from its current inner size', async () => {
    const popup = fakeWindow();
    const service = create(undefined);
    spyOn(window, 'open').and.returnValue(popup);
    await service.open();

    service.fitCollapsedHeight(270);
    expect(popup.resizeBy).toHaveBeenCalledWith(0, 191);

    service.setCollapsed(false);
    (popup.resizeBy as jasmine.Spy).calls.reset();
    service.fitCollapsedHeight(100);
    expect(popup.resizeBy).not.toHaveBeenCalled(); // expanded - the list/form don't size the window
  });

  it('corrects a window reopened at a remembered size', async () => {
    const pip = { ...fakeWindow(), innerWidth: 800, innerHeight: 90 } as unknown as Window;
    const service = create({ requestWindow: jasmine.createSpy('requestWindow').and.resolveTo(pip) });
    await service.open();
    service.fitCollapsedHeight(79);
    expect(pip.resizeBy).toHaveBeenCalledWith(-380, -11);
  });

  it('keeps one width in both states, so expanding only grows the window downward', async () => {
    const popup = fakeWindow();
    const service = create(undefined);
    spyOn(window, 'open').and.returnValue(popup);
    await service.open();
    service.setCollapsed(false);
    expect(popup.resizeBy).toHaveBeenCalledWith(0, 521);
  });

  it('closing marks the widget closed', async () => {
    const service = create(undefined);
    spyOn(window, 'open').and.returnValue(fakeWindow());
    await service.open();
    service.close();
    expect(service.isOpen()).toBeFalse();
    expect(service.mode()).toBeNull();
  });
});
