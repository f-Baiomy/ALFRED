import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { CallRecord } from '../../core/models/call.model';
import { ExportDialogService } from '../../core/services/export-dialog.service';
import { ExportDialogComponent } from './export-dialog.component';

function call(id = 'c1'): CallRecord {
  return {
    id,
    original_url: `http://localhost:9001/${id}`,
    url: `http://host.docker.internal:8080/${id}`,
    method: 'POST',
    timestamp: '2026-01-01T00:00:00.000Z',
    duration_ms: 10,
    request: { headers: {}, body: '{}' },
    response: { status: 200, headers: {}, body: '{}' },
    state: 'COMPLETED',
    source: 'internal',
  };
}

describe('ExportDialogComponent', () => {
  let dialogService: ExportDialogService;
  let component: ExportDialogComponent;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [ExportDialogComponent],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    dialogService = TestBed.inject(ExportDialogService);
    // Downloading is the browser's job and would otherwise really fire during the run; the thing
    // under test is what the dialog does AFTER handing the file over.
    spyOn(HTMLAnchorElement.prototype, 'click');
  });

  function openWith(calls: readonly CallRecord[], format: 'markdown' | 'json' = 'markdown') {
    dialogService.open(calls, null, new Map(), format);
    const fixture = TestBed.createComponent(ExportDialogComponent);
    fixture.detectChanges();
    component = fixture.componentInstance;
    return fixture;
  }

  /**
   * One capture is routinely exported more than once - the .md for a ticket and the .html for
   * someone to actually read. Closing on the first click made the second export a full re-open:
   * reselect the calls, reopen the dialog, retype the form.
   */
  it('stays open after an export, so a second format does not mean starting over', () => {
    openWith([call()]);

    component.confirmExport();

    expect(dialogService.state()).not.toBeNull();
  });

  it('reports what it saved, since a browser download is otherwise silent', () => {
    const fixture = openWith([call()]);

    expect(component.hasExported()).toBeFalse();

    component.confirmExport();
    fixture.detectChanges();

    expect(component.hasExported()).toBeTrue();
    expect(component.exportedLabel()).toBe('.md');
    expect(component.exportFeedback()).toBeTrue();
  });

  it('accumulates each format exported, rather than only remembering the last', () => {
    const fixture = openWith([call()]);

    component.confirmExport();
    component.setReportFormat('html');
    fixture.detectChanges();
    component.confirmExport();

    expect(component.exportedLabel()).toBe('.md and .html');
  });

  it('does not double-count the same format exported twice', () => {
    openWith([call()]);

    component.confirmExport();
    component.confirmExport();

    expect(component.exportedLabel()).toBe('.md');
  });

  it('forgets all of it when a different export is opened', () => {
    const fixture = openWith([call()]);
    component.confirmExport();
    fixture.detectChanges();
    expect(component.hasExported()).toBeTrue();

    dialogService.open([call('c2')], null, new Map(), 'markdown');
    fixture.detectChanges();

    expect(component.hasExported()).toBeFalse();
    expect(component.exportedLabel()).toBe('');
  });

  it('still closes when asked', () => {
    openWith([call()]);
    component.confirmExport();

    component.close();

    expect(dialogService.state()).toBeNull();
  });
});
