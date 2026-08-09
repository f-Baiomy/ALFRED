import { TestBed, fakeAsync, tick, discardPeriodicTasks } from '@angular/core/testing';
import { of } from 'rxjs';
import { ProfilesStateService } from './profiles-state.service';
import { ProfilesApiService } from '../services/profiles-api.service';
import { Profile } from '../models/profile.model';

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: 'p1',
    name: 'Ada',
    createdAt: '2026-01-01T00:00:00.000Z',
    avatar: '🦊',
    ...overrides,
  };
}

/**
 * Injects a ProfilesStateService whose polling resolves immediately to `profiles`. Same
 * fakeAsync/tick/discardPeriodicTasks contract as SessionCyclesStateService's spec, since this
 * service polls on the same kind of timer.
 */
function setup(profiles: Profile[]): ProfilesStateService {
  const apiStub: Partial<ProfilesApiService> = {
    list: () => of(profiles),
  };
  TestBed.configureTestingModule({
    providers: [{ provide: ProfilesApiService, useValue: apiStub }],
  });
  return TestBed.inject(ProfilesStateService);
}

describe('ProfilesStateService', () => {
  it('exposes the polled profiles list', fakeAsync(() => {
    const a = makeProfile({ id: 'a', name: 'Ada' });
    const state = setup([a]);
    tick();

    expect(state.profiles()).toEqual([a]);
    discardPeriodicTasks();
  }));

  it('resolves a profile id to its name via labelFor', fakeAsync(() => {
    const a = makeProfile({ id: 'a', name: 'Ada' });
    const state = setup([a]);
    tick();

    expect(state.labelFor('a')).toBe('Ada');
    discardPeriodicTasks();
  }));

  it('falls back to the raw id when no matching profile is found', fakeAsync(() => {
    const state = setup([]);
    tick();

    expect(state.labelFor('missing-id')).toBe('missing-id');
    discardPeriodicTasks();
  }));

  it('returns null for a null id', fakeAsync(() => {
    const state = setup([]);
    tick();

    expect(state.labelFor(null)).toBeNull();
    discardPeriodicTasks();
  }));
});
