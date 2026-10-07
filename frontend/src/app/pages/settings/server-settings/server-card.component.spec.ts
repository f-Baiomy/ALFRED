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

  function setUp(status: UpdateStatus, editable = true): void {
    api = jasmine.createSpyObj<ServerSettingsService>('ServerSettingsService', ['status', 'updateStatus', 'checkUpdate', 'installUpdate', 'restart']);
    api.status.and.returnValue(of(STATUS));
    api.updateStatus.and.returnValue(of(status));
    api.checkUpdate.and.returnValue(of(status));
    api.installUpdate.and.returnValue(NEVER);
    TestBed.configureTestingModule({
      imports: [ServerCardComponent],
      providers: [
        { provide: ServerSettingsService, useValue: api },
        { provide: ServerSocketService, useValue: { events$: new Subject(), reconnected$: reconnected } },
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
    api.status.and.returnValue(of({ ...STATUS, version: '1.5.0' }));
    reconnected.next();
    fixture.detectChanges();
    expect(text()).toContain('✓ Alfred 1.5.0 is running');
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
});
