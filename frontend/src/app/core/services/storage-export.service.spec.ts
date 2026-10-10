import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { StorageExportService } from './storage-export.service';
import { CallsApiService } from './calls-api.service';
import { CommentsApiService } from './comments-api.service';
import { ExportApiService } from './export-api.service';
import { ExportDialogService } from './export-dialog.service';

describe('StorageExportService', () => {
  it('loads every chosen call in full, in order, skips one deleted since, and opens the .json export', () => {
    const calls = jasmine.createSpyObj<CallsApiService>('CallsApiService', ['getSummary', 'getDetail', 'getInterception']);
    calls.getSummary.and.callFake(((id: string) => id === 'gone'
      ? throwError(() => new Error('404'))
      : of({ id, url: '/' + id, method: 'GET', timestamp: 't' })) as never);
    calls.getDetail.and.callFake(((id: string) => of({ request: { body: 'req-' + id }, response: { status: 200, body: 'res-' + id } })) as never);
    calls.getInterception.and.returnValue(of(null) as never);
    const dialog = jasmine.createSpyObj<ExportDialogService>('ExportDialogService', ['open']);
    TestBed.configureTestingModule({
      providers: [
        { provide: CallsApiService, useValue: calls },
        { provide: CommentsApiService, useValue: { listForCall: () => of([]) } },
        { provide: ExportApiService, useValue: { fetchMetadata: () => of(null) } },
        { provide: ExportDialogService, useValue: dialog },
      ],
    });

    let count = -1;
    TestBed.inject(StorageExportService).exportCalls('inbound', ['a', 'gone', 'b']).subscribe((n) => (count = n));

    expect(count).toBe(2);
    expect(calls.getDetail).toHaveBeenCalledWith('a', 'internal');
    const [opened, , , format] = dialog.open.calls.mostRecent().args;
    expect(format).toBe('json');
    expect(opened.map((c) => c.id)).toEqual(['a', 'b']);
    expect((opened[0] as unknown as { response: { body: string } }).response.body).toBe('res-a');
  });
});
