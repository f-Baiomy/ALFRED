import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { RowsPage } from '../../core/models/db-capture.model';
import { DbCaptureApiService } from '../../core/services/db-capture-api.service';
import { RedactionsStore } from '../../core/state/redactions-store.service';
import { DbRowsTableComponent } from './db-rows-table.component';

function page(offset: number, count: number, total: number): RowsPage {
  return {
    columns: [{ name: 'id', type: 'BIGINT' }],
    rows: Array.from({ length: count }, (_, i) => [{ type: 'BIGINT', value: String(offset + i) }]),
    total,
    rowsRead: total,
  };
}

describe('DbRowsTableComponent', () => {
  it('loads the first 100 rows, then the next 100 when the fixed box is scrolled to its bottom', () => {
    const rows = jasmine.createSpy('rows').and.callFake((_id: number, _part: string, offset: number) =>
      of(page(offset, Math.min(100, 250 - offset), 250)));
    TestBed.configureTestingModule({
      imports: [DbRowsTableComponent],
      providers: [{ provide: DbCaptureApiService, useValue: { rows } }, { provide: RedactionsStore, useValue: { all: signal([]) } }],
    });
    const fixture = TestBed.createComponent(DbRowsTableComponent);
    fixture.componentRef.setInput('statementId', 7);
    fixture.detectChanges();

    const box: HTMLElement = fixture.nativeElement.querySelector('[data-testid="rows-scroll"]');
    expect(box.classList).toContain('fixed');
    expect(fixture.nativeElement.querySelectorAll('tbody tr').length).toBe(100);
    expect(fixture.nativeElement.textContent).toContain('100 loaded');

    Object.defineProperty(box, 'scrollHeight', { value: 1000 });
    Object.defineProperty(box, 'clientHeight', { value: 320 });
    Object.defineProperty(box, 'scrollTop', { value: 700 });
    box.dispatchEvent(new Event('scroll'));
    fixture.detectChanges();

    expect(rows).toHaveBeenCalledWith(7, 'RESULT', 100, 100);
    expect(fixture.nativeElement.querySelectorAll('tbody tr').length).toBe(200);
  });

  it('shows a small result inline and says when rows past the limit were not kept', () => {
    TestBed.configureTestingModule({
      imports: [DbRowsTableComponent],
      providers: [{ provide: DbCaptureApiService, useValue: { rows: () => of({ ...page(0, 3, 3), rowsRead: 120480, overLimit: true }) } }, { provide: RedactionsStore, useValue: { all: signal([]) } }],
    });
    const fixture = TestBed.createComponent(DbRowsTableComponent);
    fixture.componentRef.setInput('statementId', 1);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.rows-scroll').classList).not.toContain('fixed');
    expect(fixture.nativeElement.textContent).toContain('120,480 rows returned - 3 stored');
  });

  it('searches the recorded rows on the server and pages the matches the same way', async () => {
    const rows = jasmine.createSpy('rows').and.callFake((_id: number, _part: string, offset: number) => of(page(offset, Math.min(100, 250 - offset), 250)));
    const queryRows = jasmine.createSpy('queryRows').and.returnValue(of({ columns: ['id'], rows: [['17'], ['170']], total: 2 }));
    TestBed.configureTestingModule({
      imports: [DbRowsTableComponent],
      providers: [{ provide: DbCaptureApiService, useValue: { rows, queryRows } }, { provide: RedactionsStore, useValue: { all: signal([]) } }],
    });
    const fixture = TestBed.createComponent(DbRowsTableComponent);
    fixture.componentRef.setInput('statementId', 7);
    fixture.detectChanges();

    const input: HTMLInputElement = fixture.nativeElement.querySelector('.rq-search');
    input.value = '17';
    input.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 300));
    fixture.detectChanges();

    expect(queryRows).toHaveBeenCalledWith(7, jasmine.objectContaining({ mode: 'search', text: '17', offset: 0 }), 'RESULT');
    expect(fixture.nativeElement.querySelectorAll('tbody tr').length).toBe(2);
    expect(fixture.nativeElement.textContent).toContain('2 match · 250 rows recorded');
  });
});
