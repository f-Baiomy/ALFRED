import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { CommentsStore } from './comments-store.service';
import { CommentsApiService } from '../services/comments-api.service';
import { Comment } from '../models/comment.model';

function makeComment(overrides: Partial<Comment> = {}): Comment {
  return {
    id: 'c1',
    callId: 'call-1',
    block: 'request-body',
    lineIndex: 0,
    lineText: '{',
    comment: 'note',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** BroadcastChannel dispatches asynchronously via the browser's own task queue, not zone.js's fake timers, so tests that rely on a message actually arriving use a real short delay rather than fakeAsync/tick. */
function flush(ms = 30): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setup(apiStub: Partial<CommentsApiService>): CommentsStore {
  TestBed.configureTestingModule({
    providers: [{ provide: CommentsApiService, useValue: apiStub }],
  });
  return TestBed.inject(CommentsStore);
}

describe('CommentsStore', () => {
  it('loads a call\'s comments once and caches them, skipping a second ensureLoaded', async () => {
    const listForCall = jasmine.createSpy('listForCall').and.returnValue(of([makeComment()]));
    const store = setup({ listForCall });

    store.ensureLoaded('call-1');
    store.ensureLoaded('call-1');
    await flush();

    expect(listForCall).toHaveBeenCalledTimes(1);
    expect(store.cache().get('call-1')?.length).toBe(1);
  });

  it('broadcasts an added comment to another store instance that already has the call loaded', async () => {
    const created = makeComment({ id: 'new-1', comment: 'flagged issue' });
    const sender = setup({ listForCall: () => of([]), create: () => of(created) });
    sender.ensureLoaded('call-1');
    await flush();

    // A second "tab": its own CommentsStore instance behind a fresh
    // injector, but the same BroadcastChannel name is what should carry
    // the update across regardless.
    TestBed.resetTestingModule();
    const receiver = setup({ listForCall: () => of([]) });
    receiver.ensureLoaded('call-1');
    await flush();

    sender.addComment({ callId: 'call-1', block: 'request-body', lineIndex: 0, lineText: '{', comment: 'flagged issue' });
    await flush();

    expect(receiver.cache().get('call-1')?.some((c) => c.comment === 'flagged issue')).toBe(true);
  });

  it('does not sync a call the other store instance never loaded, to avoid speculative caching', async () => {
    const created = makeComment({ id: 'new-1' });
    const sender = setup({ listForCall: () => of([]), create: () => of(created) });
    sender.ensureLoaded('call-1');
    await flush();

    TestBed.resetTestingModule();
    const receiver = setup({ listForCall: () => of([]) });
    // receiver never calls ensureLoaded('call-1')

    sender.addComment({ callId: 'call-1', block: 'request-body', lineIndex: 0, lineText: '{', comment: 'x' });
    await flush();

    expect(receiver.cache().has('call-1')).toBe(false);
  });

  it('removes a deleted comment locally and broadcasts the removal to another instance', async () => {
    const existing = makeComment({ id: 'to-delete' });
    const del = jasmine.createSpy('delete').and.returnValue(of(undefined));
    const sender = setup({ listForCall: () => of([existing]), delete: del });
    sender.ensureLoaded('call-1');
    await flush();

    TestBed.resetTestingModule();
    const receiver = setup({ listForCall: () => of([existing]) });
    receiver.ensureLoaded('call-1');
    await flush();

    sender.deleteComment('call-1', 'to-delete');
    await flush();

    expect(del).toHaveBeenCalledWith('to-delete');
    expect(sender.cache().get('call-1')).toEqual([]);
    expect(receiver.cache().get('call-1')).toEqual([]);
  });
});
