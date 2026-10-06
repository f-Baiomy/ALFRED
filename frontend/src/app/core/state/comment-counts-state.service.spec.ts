import { TestBed } from '@angular/core/testing';
import { Subject, of } from 'rxjs';
import { CommentCount } from '../models/comment.model';
import { CommentsApiService } from '../services/comments-api.service';
import { CommentCountsState } from './comment-counts-state.service';
import { COMMENT_EVENTS } from './comments-store.service';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const count = (total: number): CommentCount => ({ total, byBlock: { 'request-body': total } });

describe('CommentCountsState', () => {
  let events: Subject<string | null>;
  let counts: jasmine.Spy;
  let state: CommentCountsState;

  beforeEach(() => {
    events = new Subject<string | null>();
    counts = jasmine.createSpy('counts').and.callFake((ids: readonly string[]) => of(Object.fromEntries(ids.filter((id) => id !== 'none').map((id) => [id, count(2)]))));
    TestBed.configureTestingModule({
      providers: [{ provide: CommentsApiService, useValue: { counts } }, { provide: COMMENT_EVENTS, useValue: events }],
    });
    state = TestBed.inject(CommentCountsState);
  });

  it('batches every ask of one pass into one request, and never asks twice for a call', async () => {
    state.request('a');
    state.request('b');
    state.request('none');
    state.request('a');
    await flush();
    expect(counts).toHaveBeenCalledTimes(1);
    expect(counts.calls.argsFor(0)[0]).toEqual(['a', 'b', 'none']);
    expect(state.counts().get('a')?.total).toBe(2);
    expect(state.counts().has('none')).toBeFalse();
  });

  it('splits a big screen into requests of 100 ids - a longer URL is refused by the gateway', async () => {
    for (let i = 0; i < 1200; i++) state.request(`c${i}`);
    await flush();
    expect(counts.calls.allArgs().map((args) => (args[0] as string[]).length)).toEqual([100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100]);
  });

  it('re-counts a call when its comments change, and drops it when the last one is gone', async () => {
    state.request('a');
    await flush();
    counts.and.returnValue(of({}));
    events.next('a');
    await flush();
    expect(state.counts().has('a')).toBeFalse();
  });

  it('ignores a change to a call nobody asked about; re-counts everything after a reconnect', async () => {
    state.request('a');
    state.request('b');
    await flush();
    counts.calls.reset();
    events.next('elsewhere');
    await flush();
    expect(counts).not.toHaveBeenCalled();
    events.next(null);
    await flush();
    expect(counts.calls.argsFor(0)[0]).toEqual(['a', 'b']);
  });
});
