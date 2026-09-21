import { TestBed } from '@angular/core/testing';
import { DesktopNotificationsService } from './desktop-notifications.service';

const STORAGE_KEY = 'alfred-desktop-notifications';

/**
 * A minimal stand-in for the real `Notification` constructor/static API - jsdom/Karma's browser
 * has no OS to actually show a toast in, but the service only ever touches these three members
 * (the constructor, `.permission`, and `.requestPermission()`), so faking just those is enough to
 * exercise the real service code rather than a mock of the service itself.
 */
class FakeNotification {
  static permission: NotificationPermission = 'default';
  static requestPermission = jasmine.createSpy('requestPermission').and.resolveTo('granted' as NotificationPermission);
  static instances: { title: string; options?: NotificationOptions }[] = [];

  constructor(title: string, options?: NotificationOptions) {
    FakeNotification.instances.push({ title, options });
  }
}

describe('DesktopNotificationsService', () => {
  let originalNotification: unknown;

  beforeEach(() => {
    originalNotification = (window as unknown as { Notification?: unknown }).Notification;
    FakeNotification.permission = 'default';
    FakeNotification.requestPermission = jasmine
      .createSpy('requestPermission')
      .and.resolveTo('granted' as NotificationPermission);
    FakeNotification.instances = [];
    (window as unknown as { Notification: unknown }).Notification = FakeNotification;
    localStorage.removeItem(STORAGE_KEY);
    TestBed.configureTestingModule({});
  });

  afterEach(() => {
    (window as unknown as { Notification: unknown }).Notification = originalNotification;
    localStorage.removeItem(STORAGE_KEY);
  });

  it('starts disabled with nothing in storage', () => {
    const service = TestBed.inject(DesktopNotificationsService);
    expect(service.enabled()).toBeFalse();
    expect(service.supported).toBeTrue();
  });

  it('reports unsupported when the browser has no Notification API at all', () => {
    delete (window as unknown as { Notification?: unknown }).Notification;
    const service = TestBed.inject(DesktopNotificationsService);
    expect(service.supported).toBeFalse();
    expect(service.enabled()).toBeFalse();
  });

  it('asks the browser for permission on enable, and turns on once granted', async () => {
    const service = TestBed.inject(DesktopNotificationsService);

    await service.enable();

    expect(FakeNotification.requestPermission).toHaveBeenCalled();
    expect(service.enabled()).toBeTrue();
    expect(localStorage.getItem(STORAGE_KEY)).toBe('true');
  });

  it('does not turn on if the browser denies permission', async () => {
    FakeNotification.requestPermission = jasmine.createSpy().and.resolveTo('denied' as NotificationPermission);
    const service = TestBed.inject(DesktopNotificationsService);

    await service.enable();

    expect(service.enabled()).toBeFalse();
    expect(service.permission()).toBe('denied');
  });

  it('does not re-prompt once permission has already been denied', async () => {
    FakeNotification.permission = 'denied';
    const service = TestBed.inject(DesktopNotificationsService);

    await service.enable();

    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
    expect(service.enabled()).toBeFalse();
  });

  it('skips the prompt entirely when permission was already granted', async () => {
    FakeNotification.permission = 'granted';
    const service = TestBed.inject(DesktopNotificationsService);

    await service.enable();

    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
    expect(service.enabled()).toBeTrue();
  });

  it('disable() turns it off and persists that choice', async () => {
    const service = TestBed.inject(DesktopNotificationsService);
    await service.enable();

    service.disable();

    expect(service.enabled()).toBeFalse();
    expect(localStorage.getItem(STORAGE_KEY)).toBe('false');
  });

  it('toggle() flips between enable and disable', async () => {
    const service = TestBed.inject(DesktopNotificationsService);

    service.toggle();
    // enable() is async (it may await requestPermission) - toggle() fires and forgets it.
    await Promise.resolve();
    expect(service.enabled()).toBeTrue();

    service.toggle();
    expect(service.enabled()).toBeFalse();
  });

  it('remembers a prior enable across a fresh instance, same as PinService', async () => {
    const first = TestBed.inject(DesktopNotificationsService);
    await first.enable();

    // Simulate a page reload: a brand new injector, same localStorage, same (still granted)
    // browser permission.
    FakeNotification.permission = 'granted';
    TestBed.resetTestingModule();
    (window as unknown as { Notification: unknown }).Notification = FakeNotification;
    const second = TestBed.inject(DesktopNotificationsService);

    expect(second.enabled()).toBeTrue();
  });

  it('does not silently re-enable if permission was revoked outside the app since the last visit', () => {
    localStorage.setItem(STORAGE_KEY, 'true');
    FakeNotification.permission = 'denied';

    const service = TestBed.inject(DesktopNotificationsService);

    // The stored preference says "on", but the browser no longer actually allows it - reading
    // that as enabled would silently promise a notification that will never arrive.
    expect(service.enabled()).toBeFalse();
  });

  it('notify() shows nothing when disabled', () => {
    const service = TestBed.inject(DesktopNotificationsService);

    service.notify('Alfred', { body: 'test' });

    expect(FakeNotification.instances.length).toBe(0);
  });

  it('notify() shows a real Notification once enabled', async () => {
    const service = TestBed.inject(DesktopNotificationsService);
    await service.enable();

    service.notify('Alfred — call paused', { body: 'Review orders is holding POST /order' });

    expect(FakeNotification.instances.length).toBe(1);
    expect(FakeNotification.instances[0].title).toBe('Alfred — call paused');
    expect(FakeNotification.instances[0].options?.body).toContain('Review orders');
  });
});
