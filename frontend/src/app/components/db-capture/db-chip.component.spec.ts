import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { CallRecord } from '../../core/models/call.model';
import { CallDbSummary, DbFlag } from '../../core/models/db-capture.model';
import { DbCaptureStateService } from '../../core/state/db-capture-state.service';
import { DbChipComponent } from './db-chip.component';
import { DbWindowService } from './db-window.service';

function summary(overrides: Partial<CallDbSummary> = {}): CallDbSummary {
  return {
    callId: 'c1', statementCount: 41, writeCount: 0, deleteCount: 0, failedCount: 0, transactionCount: 2, rolledBackCount: 0,
    dbMicros: 9000, droppedCount: 0, flags: [], lastSeq: 41, complete: true, endedEarly: false, ...overrides,
  };
}

const call: CallRecord = {
  id: 'c1', original_url: 'http://localhost:8080/search', url: 'http://wildfly/search', method: 'POST', timestamp: '2026-10-05T16:03:35Z',
  duration_ms: 20035, source: 'internal', response: { status: 200, headers: {}, body: '{}' },
};

describe('DbChipComponent', () => {
  const summaries = signal<ReadonlyMap<string, CallDbSummary>>(new Map());

  function render(s: CallDbSummary): HTMLButtonElement {
    summaries.set(new Map([['c1', s]]));
    const fixture = TestBed.createComponent(DbChipComponent);
    fixture.componentRef.setInput('call', call);
    fixture.detectChanges();
    return fixture.nativeElement.querySelector('button.db-chip');
  }

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [DbChipComponent],
      providers: [
        { provide: DbCaptureStateService, useValue: { summaries, showChips: signal(true), requestSummary: () => undefined } },
        { provide: DbWindowService, useValue: { openCall: () => undefined } },
      ],
    });
  });

  it('stays the teal ◆ chip when no statement failed', () => {
    const chip = render(summary());
    expect(chip.classList).not.toContain('failed');
    expect(chip.textContent).toContain('◆ DB 41');
    expect(chip.title).toBe("Open this call's database statements");
  });

  it('turns red on a call that answered 200 while a statement failed and was swallowed, naming it on hover', () => {
    const swallowed: DbFlag = { type: 'FAILED_SWALLOWED', severity: 'BAD', seqs: [42], detail: { error: '42000', table: 'LOG_FLIGHTSEARCH_HIT_DETAILS_SP_V6' } };
    const chip = render(summary({ failedCount: 1, flags: [swallowed] }));
    expect(chip.classList).toContain('failed');
    expect(chip.textContent).toContain('✖ DB 41');
    expect(chip.textContent).toContain('1 failed');
    expect(chip.textContent).toContain('swallowed');
    expect(chip.title).toContain('#42 LOG_FLIGHTSEARCH_HIT_DETAILS_SP_V6 failed (42000) and was swallowed - the call still answered 200');
  });

  it('says how many more failed than the flags name', () => {
    const failed: DbFlag = { type: 'FAILED', severity: 'BAD', seqs: [7], detail: { error: '23000' } };
    const chip = render(summary({ failedCount: 3, flags: [failed] }));
    expect(chip.title).toContain('#7 failed (23000)');
    expect(chip.title).toContain('…and 2 more');
    expect(chip.textContent).not.toContain('swallowed');
  });
});
