import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NEVER, Subject, of, throwError } from 'rxjs';
import { ServerCardComponent } from './server-card.component';
import { ServerSettingsService } from '../../../core/services/server-settings.service';
import { ServerSocketService } from '../../../core/services/server-socket.service';
import { ServerStatus, UpdateStatus } from '../../../core/models/server-settings.model';

const STATUS: ServerStatus = {
  version: '1.4.0', installDir: 'C:\\alfred', mode: 'NATIVE', startedAt: '2026-10-08T10:00:00Z', backendPid: 1,
  heapUsedBytes: 1, heapMaxBytes: 2,
  processes: [{ name: 'BACKEND', state: 'RUNNING', pid: 1, startedAt: null, restarts: 0, listeners: [], detail: '', callsLastHour: -1 }],
  agents: [],
};

function update(over: Partial<UpdateStatus> = {}): UpdateStatus {
  return {
    mode: 'CHECK', runtimeMode: 'NATIVE', target: 'windows-x64', currentVersion: '1.4.0', latestVersion: '1.5.0', available: true,
    checkedAt: new Date().toISOString(), feedUrl: 'https://feed', notes: 'Faster exports', publishedAt: new Date(Date.now() - 2 * 86400000).toISOString(),
    installerUrl: 'https://dl/x.exe', sizeBytes: 150 * 1024 * 1024, window: '02:00-04:00', canInstall: true,
    job: { state: 'IDLE', version: '', downloadedBytes: 0, totalBytes: 0, error: '' }, error: '',
    ...over,
  };
}

describe('ServerCardComponent - updates', () => {
  let fixture: ComponentFixture<ServerCardComponent>;
  let api: jasmine.SpyObj<ServerSettingsService>;
  const reconnected = new Subject<void>();
  const disconnected = new Subject<void>();

  function setUp(status: UpdateStatus, editable = true): void {
    api = jasmine.createSpyObj<ServerSettingsService>('ServerSettingsService', ['status', 'updateStatus', 'checkUpdate', 'installUpdate', 'pauseUpdate', 'cancelUpdate', 'restart']);
    api.status.and.returnValue(of(STATUS));
    api.updateStatus.and.returnValue(of(status));
    api.checkUpdate.and.returnValue(of(status));
    api.installUpdate.and.returnValue(NEVER);
    api.pauseUpdate.and.returnValue(of({ accepted: true }));
    api.cancelUpdate.and.returnValue(of({ accepted: true }));
    TestBed.configureTestingModule({
      imports: [ServerCardComponent],
      providers: [
        { provide: ServerSettingsService, useValue: api },
        { provide: ServerSocketService, useValue: { events$: new Subject(), reconnected$: reconnected, disconnected$: disconnected } },
      ],
    });
    fixture = TestBed.createComponent(ServerCardComponent);
    fixture.componentRef.setInput('editable', editable);
    fixture.detectChanges();
  }

  const text = () => (fixture.nativeElement as HTMLElement).textContent ?? '';
  const button = (label: string) => Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('button'))
    .find(b => b.textContent?.trim() === label) as HTMLButtonElement | undefined;

  it('shows an available release with its size, age and notes, and the install button to an editor', () => {
    setUp(update());
    expect(text()).toContain('Alfred 1.5.0 available');
    expect(text()).toContain('150 MB');
    expect(text()).toContain('released 2 days ago');
    expect(text()).toContain('Faster exports');
    expect(button('Install update')).toBeTruthy();
    expect(button('Check now')).toBeTruthy();
  });

  it('a read-only viewer sees the release but cannot install it', () => {
    setUp(update(), false);
    expect(text()).toContain('Alfred 1.5.0 available');
    expect(button('Install update')).toBeUndefined();
  });

  it('says up to date, off, and a failed check for what they are', () => {
    setUp(update({ available: false, latestVersion: '1.4.0' }));
    expect(text()).toContain('Up to date');
    fixture.destroy();
    TestBed.resetTestingModule();
    setUp(update({ mode: 'OFF', available: false }));
    expect(text()).toContain('Update checks are off');
    expect(button('Check now')).toBeUndefined();
    fixture.destroy();
    TestBed.resetTestingModule();
    setUp(update({ available: false, latestVersion: '', error: 'Could not read https://feed: HTTP 503' }));
    expect(text()).toContain('HTTP 503');
  });

  it('shows the install in progress and a failed one with the reason', () => {
    setUp(update({ canInstall: false, job: { state: 'DOWNLOADING', version: '1.5.0', downloadedBytes: 75 * 1024 * 1024, totalBytes: 150 * 1024 * 1024, error: '' } }));
    expect(text()).toContain('downloading Alfred 1.5.0 50%');
    expect(button('Install update')).toBeUndefined();
    fixture.destroy();
    TestBed.resetTestingModule();
    setUp(update({ job: { state: 'FAILED', version: '1.5.0', downloadedBytes: 0, totalBytes: 0, error: 'checksum mismatch' } }));
    expect(text()).toContain('Update to 1.5.0 failed: checksum mismatch');
  });

  it('installing asks for confirmation, then calls install and reports the new version when the socket reconnects', () => {
    setUp(update());
    button('Install update')!.click();
    fixture.detectChanges();
    expect(text()).toContain('Install Alfred 1.5.0?');
    expect(api.installUpdate).not.toHaveBeenCalled();
    button('Install and restart')!.click();
    fixture.detectChanges();
    expect(api.installUpdate).toHaveBeenCalled();
    expect(text()).toContain('Installing Alfred 1.5.0');
    expect(text()).toContain('Downloading the installer');
    api.updateStatus.and.returnValue(of(update({ job: { state: 'INSTALLING', version: '1.5.0', downloadedBytes: 1, totalBytes: 1, error: '' } })));
    fixture.componentInstance.load();
    api.status.and.returnValue(of({ ...STATUS, version: '1.5.0' }));
    disconnected.next();
    reconnected.next();
    fixture.detectChanges();
    expect(text()).toContain('Alfred 1.5.0 is running');
    expect(text()).toContain('100%');
    expect(button('Reload')).toBeTruthy();
  });

  it('the dialog follows the job: the download bar with its bytes, then verifying, then a failure with its reason', () => {
    setUp(update());
    fixture.componentInstance.askUpdate();
    fixture.componentInstance.restart();
    api.updateStatus.and.returnValue(of(update({ job: { state: 'DOWNLOADING', version: '1.5.0', downloadedBytes: 75 * 1024 * 1024, totalBytes: 150 * 1024 * 1024, error: '' } })));
    fixture.componentInstance.load();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.srv-bar.small')?.getAttribute('aria-valuenow')).toBe('50');
    expect(el.querySelector('.srv-bar:not(.small)')?.getAttribute('aria-valuenow')).toBe('30');
    expect(text()).toContain('75 MB of 150 MB');
    api.updateStatus.and.returnValue(of(update({ job: { state: 'FAILED', version: '1.5.0', downloadedBytes: 0, totalBytes: 0, error: "the downloaded installer's checksum is ab12…" } })));
    fixture.componentInstance.load();
    fixture.detectChanges();
    expect(text()).toContain('Update failed');
    expect(text()).toContain('checksum is ab12');
    expect(text()).toContain('Nothing was installed');
    expect(el.querySelector('.srv-step.fail')).toBeTruthy();
  });

  it('Alfred coming back on the old version is a failure, not "running"', () => {
    setUp(update());
    fixture.componentInstance.askUpdate();
    fixture.componentInstance.restart();
    api.updateStatus.and.returnValue(of(update({ job: { state: 'INSTALLING', version: '1.5.0', downloadedBytes: 1, totalBytes: 1, error: '' } })));
    fixture.componentInstance.load();
    disconnected.next();
    reconnected.next();
    fixture.detectChanges();
    expect(text()).toContain('Alfred came back on 1.4.0, not 1.5.0');
    expect(text()).toContain('Alfred is running the version it had');
    expect(button('Reload')).toBeUndefined();
  });

  it('a drop and reconnect during the download (a network blip) does not end the install', () => {
    setUp(update());
    fixture.componentInstance.askUpdate();
    fixture.componentInstance.restart();
    api.updateStatus.and.returnValue(of(update({ job: { state: 'DOWNLOADING', version: '1.5.0', downloadedBytes: 1, totalBytes: 150 * 1024 * 1024, error: '' } })));
    fixture.componentInstance.load();
    disconnected.next();
    fixture.detectChanges();
    expect(fixture.componentInstance.dropped()).toBeFalse();
    reconnected.next();
    fixture.detectChanges();
    expect(fixture.componentInstance.view()?.outcome).toBe('running');
    expect(text()).not.toContain('is running');
  });

  it('a refused install shows the backend reason', () => {
    setUp(update());
    api.installUpdate.and.returnValue(throwError(() => ({ error: { message: 'Alfred 1.5.0 is up to date' } })));
    fixture.componentInstance.askUpdate();
    fixture.componentInstance.restart();
    fixture.detectChanges();
    expect(text()).toContain('Alfred 1.5.0 is up to date');
  });

  it('check now re-reads the feed', () => {
    setUp(update({ available: false, latestVersion: '1.4.0' }));
    api.checkUpdate.and.returnValue(of(update()));
    button('Check now')!.click();
    fixture.detectChanges();
    expect(api.checkUpdate).toHaveBeenCalled();
    expect(text()).toContain('Alfred 1.5.0 available');
  });

  const job = (state: any, over: any = {}) => ({ state, version: '1.5.0', downloadedBytes: 58, totalBytes: 100, error: '', ...over });
  const releases = [
    { version: '1.6.0', publishedAt: '', notes: 'Relive SQL replay\nthe second line is not shown', sizeBytes: 151 * 1024 * 1024 },
    { version: '1.5.0', publishedAt: '', notes: 'Fixes only', sizeBytes: 150 * 1024 * 1024 },
  ];

  it('with several newer releases the dialog lets you choose, the newest first, and installs the one chosen', () => {
    setUp(update({ latestVersion: '1.6.0', releases }));
    expect(text()).toContain('2 newer releases');
    button('Install update')!.click();
    fixture.detectChanges();
    expect(text()).toContain('Install Alfred 1.6.0?');
    const radios = (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLInputElement>('input[name=release]');
    expect(radios.length).toBe(2);
    expect(text()).toContain('Relive SQL replay');
    expect(text()).not.toContain('the second line');
    radios[1].click();
    radios[1].dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(text()).toContain('Install Alfred 1.5.0?');
    button('Install and restart')!.click();
    expect(api.installUpdate).toHaveBeenCalledWith('1.5.0');
  });

  it('a running download can be paused or cancelled from the dialog, and the dialog ends with it', () => {
    setUp(update());
    fixture.componentInstance.askUpdate();
    fixture.componentInstance.restart();
    api.updateStatus.and.returnValue(of(update({ canInstall: false, job: job('DOWNLOADING') })));
    fixture.componentInstance.load();
    fixture.detectChanges();
    expect(button('Pause')).toBeTruthy();
    expect(button('Cancel')).toBeTruthy();
    api.updateStatus.and.returnValue(of(update({ job: job('PAUSED') })));
    button('Pause')!.click();
    fixture.detectChanges();
    expect(api.pauseUpdate).toHaveBeenCalled();
    expect(fixture.componentInstance.progressKind()).toBeNull();
    expect(text()).toContain('update to 1.5.0 paused at 58%');
    expect(button('Resume')).toBeTruthy();
    expect(button('Discard')).toBeTruthy();
  });

  it('a paused download resumes as the same release, or is discarded', () => {
    setUp(update({ job: job('PAUSED') }));
    button('Resume')!.click();
    fixture.detectChanges();
    expect(text()).toContain('Install Alfred 1.5.0?');
    button('Install and restart')!.click();
    expect(api.installUpdate).toHaveBeenCalledWith('1.5.0');
    fixture.destroy();
    TestBed.resetTestingModule();
    setUp(update({ job: job('PAUSED') }));
    button('Discard')!.click();
    expect(api.cancelUpdate).toHaveBeenCalled();
  });

  it('a version that did not start says so, once, and that a retry needs no download', () => {
    const error = 'Alfred 1.5.0 was installed but did not start: port 3000 is in use by node.exe (pid 4410). Alfred 1.4.0 was put back.';
    setUp(update({ job: job('FAILED', { error }) }));
    expect(text()).toContain('port 3000 is in use by node.exe');
    expect(text()).not.toContain('The previous version was kept');
    expect(text()).toContain('installing again needs no download');
  });
});
