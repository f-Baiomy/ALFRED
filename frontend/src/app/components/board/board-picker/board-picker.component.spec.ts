import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { Subject, of } from 'rxjs';
import { BoardSummary } from '../../../core/models/board.models';
import { BoardApiService } from '../../../core/services/board-api.service';
import { BoardSocketService } from '../../../core/services/board-socket.service';
import { SessionsStateService } from '../../../core/state/sessions-state.service';
import { BoardPickerComponent } from './board-picker.component';

const board = (id: string, name: string, isDefault = false, linkedItem: string | null = null): BoardSummary => ({
  board: { id, project: 'odeysys', name, isDefault, state: 'OPEN', migratedFrom: null, createdAt: '', updatedAt: '' },
  cards: 2, cycleIds: [], boardIds: [], linkedItem });

describe('BoardPickerComponent (specs/032 T040)', () => {
  it('is "▦ Boards ▾"; each task board shows its ref, plain title, stage and holder', () => {
    const api = { boards: () => of([board('default:odeysys', 'odeysys', true), board('b1', '#59851_Q4-INTE-CORE-015 Baggage Bundle', false, 'c1/59851'),
      board('b2', 'Login lockout')]), stage: (id: string) => of({ stage: id === 'b1' ? 'VERIFY' : 'DEFINE' }) };
    TestBed.configureTestingModule({ imports: [BoardPickerComponent], providers: [provideHttpClient(), provideHttpClientTesting(),
      { provide: BoardApiService, useValue: api }, { provide: BoardSocketService, useValue: { events$: new Subject(), reconnected$: new Subject() } }] });
    const sessions = TestBed.inject(SessionsStateService);
    sessions.me.set({ user: 'me@x', machine: null, kind: null, keyId: null, helperKeyId: null, admin: false });
    sessions.holders.set([{ boardId: 'b1', project: 'odeysys', user: 'me@x', machine: '', sessionId: null, since: '', commenters: [], request: null }]);
    const f = TestBed.createComponent(BoardPickerComponent);
    f.componentRef.setInput('project', 'odeysys');
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    expect(el.querySelector('.board-picker-btn')!.textContent!.replace(/\s+/g, ' ').trim()).toBe('▦ Boards ▼');
    (el.querySelector('.board-picker-btn') as HTMLButtonElement).click();
    f.detectChanges();
    const items = Array.from(el.querySelectorAll('.board-picker-item.col')).map((i) => Array.from(i.children).map((c) => c.textContent!.trim()).join(' | '));
    expect(items).toEqual(['AB#59851 · Baggage Bundle | odeysys · Verify · you', 'Login lockout | odeysys · Define · free']);
  });
});
