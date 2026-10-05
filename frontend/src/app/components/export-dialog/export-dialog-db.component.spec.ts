import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { of } from 'rxjs';
import { CallRecord } from '../../core/models/call.model';
import { CallDbCapture } from '../../core/models/db-capture.model';
import { ExportDialogService } from '../../core/services/export-dialog.service';
import { DbCaptureApiService } from '../../core/services/db-capture-api.service';
import { CallsApiService } from '../../core/services/calls-api.service';
import { stmt } from '../../shared/utils/db-capture.fixtures.spec-helper';
import { ExportDialogComponent } from './export-dialog.component';

const inbound: CallRecord = {
  id: 'in-1', original_url: 'http://localhost:9001/pay', url: 'http://host.docker.internal:8080/pay', method: 'POST',
  timestamp: '2026-01-01T00:00:00.000Z', duration_ms: 10, request: { headers: {}, body: '{}' },
  response: { status: 200, headers: {}, body: '{}' }, state: 'COMPLETED', source: 'internal',
};

const capture: CallDbCapture = { transactions: [], statements: [stmt(1, 'SELECT', 'SELECT secret_column FROM vault')] };

/** "◆ Include database statements" - offered when a call was captured, off by default, fetched only when ticked. */
describe('ExportDialogComponent - database statements', () => {
  let exportCall: jasmine.Spy;
  let written: string[];

  beforeEach(() => {
    exportCall = jasmine.createSpy('exportCall').and.returnValue(of(capture));
    TestBed.configureTestingModule({
      imports: [ExportDialogComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: DbCaptureApiService, useValue: { exportCall, summaries: () => of({ 'in-1': { callId: 'in-1', statementCount: 1 } }) } },
        { provide: CallsApiService, useValue: { getChildren: () => of([]) } },
      ],
    });
    written = [];
    spyOn(navigator.clipboard, 'writeText').and.callFake((text: string) => {
      written.push(text);
      return Promise.resolve();
    });
  });

  function open() {
    TestBed.inject(ExportDialogService).open([inbound], null, new Map(), 'markdown');
    const fixture = TestBed.createComponent(ExportDialogComponent);
    fixture.detectChanges();
    fixture.detectChanges(); // the summaries arrive from the open effect
    return fixture;
  }

  it('offers the option unticked, and leaves statements out until it is ticked', async () => {
    const fixture = open();
    const box: HTMLInputElement = fixture.nativeElement.querySelector('.dialog-db-option input[type="checkbox"]');
    expect(box).not.toBeNull();
    expect(box.checked).toBeFalse();
    expect(fixture.nativeElement.textContent).toContain('This call has 1 captured statement.');
    expect(exportCall).not.toHaveBeenCalled();

    fixture.componentInstance.copyToClipboard();
    await fixture.whenStable();
    expect(written[0]).not.toContain('secret_column');

    box.click();
    fixture.detectChanges();
    expect(exportCall).toHaveBeenCalledWith('in-1');
    fixture.componentInstance.copyToClipboard();
    await fixture.whenStable();
    expect(written[1]).toContain('🗄 Database');
    expect(written[1]).toContain('secret_column');
  });

  it('starts unticked again on every open', () => {
    const fixture = open();
    fixture.componentInstance.setIncludeDb(true);
    TestBed.inject(ExportDialogService).open([inbound], null, new Map(), 'markdown');
    fixture.detectChanges();
    expect(fixture.componentInstance.includeDb()).toBeFalse();
  });

  it('lays the included statements out as chosen - grouped by default, flat when unticked', async () => {
    localStorage.removeItem('alfred.dbCapture.groupByTransaction');
    const fixture = open();
    fixture.componentInstance.setIncludeDb(true);
    fixture.detectChanges();
    const sub: HTMLInputElement = fixture.nativeElement.querySelector('.dialog-db-sub input');
    expect(sub.checked).toBeTrue();
    fixture.componentInstance.setGroupDb(false);
    fixture.componentInstance.copyToClipboard();
    await fixture.whenStable();
    expect(written[0]).toContain('🗄 Database');
    expect(localStorage.getItem('alfred.dbCapture.groupByTransaction')).toBe('0');
    localStorage.removeItem('alfred.dbCapture.groupByTransaction');
  });
});

