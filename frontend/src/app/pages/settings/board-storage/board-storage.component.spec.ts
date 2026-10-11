import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { BoardStorage } from '../../../core/models/board.models';
import { BoardApiService } from '../../../core/services/board-api.service';
import { BoardStorageComponent } from './board-storage.component';

const BEFORE: BoardStorage = { fileBytes: 48_000_000, usedBytes: 12_000_000, freeBytes: 36_000_000, cards: 412, comments: 3120, specFiles: 9, briefs: 14,
  cardsOfDeletedCycles: 9 };
const AFTER: BoardStorage = { ...BEFORE, fileBytes: 12_100_000, freeBytes: 0 };

describe('BoardStorageComponent', () => {
  it('shows the free space and compacts it', () => {
    const compact = jasmine.createSpy('compact').and.returnValue(of({ before: BEFORE, after: AFTER }));
    TestBed.configureTestingModule({
      imports: [BoardStorageComponent],
      providers: [provideRouter([]), { provide: BoardApiService, useValue: { storage: () => of(BEFORE), compact } }],
    });
    const f = TestBed.createComponent(BoardStorageComponent);
    f.detectChanges();
    const el: HTMLElement = f.nativeElement;
    expect(el.textContent).toContain('412 · 3120 · 9 · 14');
    const button = Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('Compact'))!;
    expect(button.disabled).toBeFalse();
    button.click();
    f.detectChanges();
    expect(compact).toHaveBeenCalled();
    expect(el.textContent).toContain('Compacted');
    expect(Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('Compact'))!.disabled).toBeTrue();
  });
});
