import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NEVER, Subject, of } from 'rxjs';
import { ServerSettingsComponent } from './server-settings.component';
import { ServerSettingsService } from '../../../core/services/server-settings.service';
import { ServerSocketService } from '../../../core/services/server-socket.service';
import { EditAccess, ServerSetting, ServerSettingsResponse, SettingsPreview } from '../../../core/models/server-settings.model';

function setting(key: string, kind: ServerSetting['kind'], value: string, extra: Partial<ServerSetting> = {}): ServerSetting {
  return {
    key, kind, value, group: 'STORAGE', label: key, help: 'help', applies: 'RESTART', enumValues: [], min: null, max: null,
    isSet: true, defaultValue: value, source: 'ENV_FILE', differsFromDefault: false, pending: null, ...extra,
  };
}

const DATA: ServerSettingsResponse = {
  mode: 'NATIVE', envLocation: '/opt/alfred/.env', envHash: 'h1',
  settings: [
    setting('ALFRED_MEMORY', 'MEMORY', '2g'),
    setting('INTERNAL_CALL_SERVICES', 'PROJECT_LIST', 'a:9001:8080', { group: 'PROJECTS', applies: 'PROXIES' }),
  ],
  missingFromEnv: [], unknownLines: [], pendingRestart: [],
};

const PREVIEW: SettingsPreview = {
  diff: [{ key: 'ALFRED_MEMORY', before: 'ALFRED_MEMORY=2g', after: 'ALFRED_MEMORY=3g' }],
  effects: [{ key: 'ALFRED_MEMORY', applies: 'RESTART' }],
  results: [],
};

describe('ServerSettingsComponent', () => {
  let fixture: ComponentFixture<ServerSettingsComponent>;
  let api: jasmine.SpyObj<ServerSettingsService>;

  function setUp(access: EditAccess): void {
    api = jasmine.createSpyObj<ServerSettingsService>('ServerSettingsService',
      ['access', 'settings', 'preview', 'save', 'addMissing', 'status', 'restart', 'importEnv', 'downloadEnv',
        'updateStatus', 'checkUpdate', 'installUpdate']);
    api.access.and.returnValue(of(access));
    api.settings.and.returnValue(of(DATA));
    api.preview.and.returnValue(of(PREVIEW));
    api.status.and.returnValue(NEVER);
    api.updateStatus.and.returnValue(NEVER);
    TestBed.configureTestingModule({
      imports: [ServerSettingsComponent],
      providers: [
        { provide: ServerSettingsService, useValue: api },
        { provide: ServerSocketService, useValue: { events$: new Subject(), reconnected$: new Subject() } },
      ],
    });
    fixture = TestBed.createComponent(ServerSettingsComponent);
    fixture.detectChanges();
  }

  function el(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  it('keeps save disabled until something changes, then reviews the exact .env lines', () => {
    setUp({ allowed: true, reason: 'LOCAL', clientAddress: '127.0.0.1', howToEdit: '' });
    const review = Array.from(el().querySelectorAll('button')).find(b => b.textContent?.includes('Review and save')) as HTMLButtonElement;
    expect(review.disabled).toBeTrue();

    const row = Array.from(el().querySelectorAll('.server-row')).find(r => r.querySelector('small')?.textContent === 'ALFRED_MEMORY')!;
    const memory = row.querySelector('input[type="text"]') as HTMLInputElement;
    memory.value = '3g';
    memory.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(review.disabled).toBeFalse();
    expect(el().textContent).toContain('1 unsaved change');

    review.click();
    fixture.detectChanges();
    expect(api.preview).toHaveBeenCalledWith('h1', [{ key: 'ALFRED_MEMORY', value: '3g' }]);
    expect(el().querySelector('.server-diff')?.textContent).toContain('+ ALFRED_MEMORY=3g');
    expect(el().textContent).toContain('needs a restart of Alfred');
  });

  it('is read-only through the tunnel: no save bar, inputs disabled, and says how to edit', () => {
    setUp({ allowed: false, reason: 'TUNNEL', clientAddress: '127.0.0.1', howToEdit: 'Open Alfred through an SSH tunnel.' });
    expect(el().textContent).toContain('Read-only.');
    expect(el().textContent).toContain('SSH tunnel');
    expect(el().querySelector('.server-savebar')).toBeNull();
    expect(Array.from(el().querySelectorAll('input[type="text"]')).every(i => (i as HTMLInputElement).disabled)).toBeTrue();
    expect(Array.from(el().querySelectorAll('button')).some(b => b.textContent?.includes('Add project'))).toBeFalse();
  });

  it('puts the picked values of an uploaded .env in the form, never an invalid one', () => {
    setUp({ allowed: true, reason: 'LOCAL', clientAddress: '127.0.0.1', howToEdit: '' });
    api.importEnv.and.returnValue(of({
      values: [
        { key: 'ALFRED_MEMORY', value: '3g', current: '2g', valid: true, message: '' },
        { key: 'INTERNAL_CALL_SERVICES', value: 'a:70000:1', current: 'a:9001:8080', valid: false, message: 'a port is 1-65535' },
        { key: 'ALFRED_UI_PORT', value: '3000', current: '3000', valid: true, message: '' },
      ],
      unknown: ['FOO'], secrets: ['WEBHOOK_SECRET'],
    }));
    const input = el().querySelector('.server-upload input[type="file"]') as HTMLInputElement;
    const file = new File(['ALFRED_MEMORY=3g'], 'other.env', { type: 'text/plain' });
    Object.defineProperty(input, 'files', { value: [file] });
    input.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    const dialog = el().querySelector('[aria-label="Upload .env"]') as HTMLElement;
    expect(dialog.textContent).toContain('ALFRED_MEMORY');
    expect(dialog.textContent).not.toContain('ALFRED_UI_PORT');
    expect(dialog.textContent).toContain('a port is 1-65535');
    expect(dialog.textContent).toContain('Secrets are never imported: WEBHOOK_SECRET');
    const boxes = Array.from(dialog.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];
    expect(boxes.map(b => [b.checked, b.disabled])).toEqual([[true, false], [false, true]]);

    const take = Array.from(dialog.querySelectorAll('button')).find(b => b.textContent?.includes('Put 1 value')) as HTMLButtonElement;
    take.click();
    fixture.detectChanges();
    expect(el().querySelector('[aria-label="Upload .env"]')).toBeNull();
    expect(el().textContent).toContain('1 unsaved change');
  });
});
