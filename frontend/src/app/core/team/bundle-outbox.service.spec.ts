import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { of } from 'rxjs';
import { TeamApiService } from './team-api.service';
import { TeamStateService } from './team-state.service';
import { TeamSocketEvent, WriteBundle } from './team.models';
import { BundleOutboxService } from './bundle-outbox.service';

const b = (id: number, state: WriteBundle['state'], cardId: string | null, askedIn: string | null = null): WriteBundle => ({
  id, boardId: 'b1', cardId, conn: 'c1', item: '1', origin: 'CLAUDE', askedIn, title: 't', state, createdAt: `2026-10-18T20:0${id}:00Z`,
  decidedAt: null, decidedBy: null, steps: [{ kind: 'COMMENT', payload: { text: 'x' }, ticked: true, unmasked: false }],
});

describe('BundleOutboxService (specs/034)', () => {
  it('holds the board\'s waiting bundles by card and by the message that asked, and says ⇪n in the title', async () => {
    const event = signal<TeamSocketEvent | null>(null);
    const api = jasmine.createSpyObj<TeamApiService>('TeamApiService', ['bundles']);
    api.bundles.and.callFake((f) => of(f.state === 'WAITING' ? [b(2, 'WAITING', 'k1', '9'), b(1, 'WAITING', 'k1')] : f.state === 'DONE' ? [b(3, 'DONE', 'k2', '9')] : []));
    TestBed.configureTestingModule({ providers: [
      { provide: TeamApiService, useValue: api },
      { provide: TeamStateService, useValue: { boardEvent: event } },
    ] });
    document.title = '(3) Alfred Dashboard';
    const o = TestBed.inject(BundleOutboxService);
    o.watch('b1');
    TestBed.flushEffects();
    expect(o.count()).toBe(2);
    expect(o.waiting().map((x) => x.id)).toEqual([1, 2]); // oldest first
    expect(o.byCard().get('k1')?.length).toBe(2);
    expect(o.byAsk().get('9')?.map((x) => x.id)).toEqual([2, 3]);
    expect(document.title).toBe('(3) ⇪2 Alfred Dashboard');

    o.replace({ ...b(2, 'WAITING', 'k1'), state: 'DONE' });
    TestBed.flushEffects();
    expect(o.count()).toBe(1);
    expect(document.title).toBe('(3) ⇪1 Alfred Dashboard');

    api.bundles.calls.reset();
    event.set({ type: 'team-changed', conn: 'c1', board: 'b2', what: 'write' });
    TestBed.flushEffects();
    expect(api.bundles).not.toHaveBeenCalled(); // another board's bundle
    event.set({ type: 'team-changed', conn: 'c1', board: 'b1', what: 'write' });
    TestBed.flushEffects();
    expect(api.bundles).toHaveBeenCalled();
    document.title = 'Alfred Dashboard';
  });
});
