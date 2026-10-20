import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { of } from 'rxjs';
import { TeamApiService } from './team-api.service';
import { TeamStateService } from './team-state.service';
import { TeamItemPeekService } from './item-peek.service';

describe('TeamItemPeekService', () => {
  function setUp(picked: string | null) {
    const api = { connections: jasmine.createSpy('connections').and.returnValue(of([{ id: 'first' }])) };
    TestBed.configureTestingModule({
      providers: [
        { provide: TeamApiService, useValue: api },
        { provide: TeamStateService, useValue: { loaded: signal(true), load: () => undefined, picked: () => (picked ? { id: picked } : null) } },
      ],
    });
    return { peek: TestBed.inject(TeamItemPeekService), api };
  }

  it('opens an AB# item on the picked connection, over the page', () => {
    const { peek, api } = setUp('c1');
    peek.open('*', '60916');
    expect(peek.opened()).toEqual({ conn: 'c1', item: '60916' });
    expect(api.connections).not.toHaveBeenCalled();
    peek.close();
    expect(peek.opened()).toBeNull();
  });

  it('with no connection picked yet, uses the first one; a named connection stays itself', () => {
    const { peek } = setUp(null);
    peek.open('*', '1');
    expect(peek.opened()).toEqual({ conn: 'first', item: '1' });
    peek.open('c9', '2');
    expect(peek.opened()).toEqual({ conn: 'c9', item: '2' });
  });
});
