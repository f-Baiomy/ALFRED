import { TestBed } from '@angular/core/testing';
import { CardViewModeService } from './card-view-mode.service';

describe('CardViewModeService', () => {
  const KEY = 'alfred_card_view_mode';
  afterEach(() => localStorage.removeItem(KEY));

  function service(): CardViewModeService {
    TestBed.resetTestingModule();
    return TestBed.inject(CardViewModeService);
  }

  it('opens cards in the side panel until the user picks something else, then remembers the choice', () => {
    localStorage.removeItem(KEY);
    expect(service().mode()).toBe('side');
    service().set('full');
    expect(service().mode()).toBe('full');
  });

  it('ignores a stored value it does not know', () => {
    localStorage.setItem(KEY, 'sideways');
    expect(service().mode()).toBe('side');
  });

  it('builds the card window URL from the project, cycle and number', () => {
    const s = service();
    expect(s.windowUrl({ project: 'odeysys', cycleId: 'c1', number: 27 })).toBe('/board?project=odeysys&cycle=c1&card=27&window=1');
    expect(s.windowUrl({ project: '', cycleId: null, number: 3 })).toBe('/board?card=3&window=1');
  });

  it('opens one reused popup for a card', () => {
    const open = spyOn(window, 'open');
    service().popOut({ project: 'odeysys', cycleId: null, number: 27 });
    expect(open).toHaveBeenCalledWith('/board?project=odeysys&card=27&window=1', 'alfred-card', jasmine.stringContaining('popup'));
  });

  it('hands a card back to a listening board tab, which takes the mode and answers', async () => {
    const s = service();
    const opened: unknown[] = [];
    const stop = s.listen((target, mode) => opened.push([target.number, mode]) > 0);
    const answered = await s.dock({ project: 'odeysys', cycleId: null, number: 27 }, 'full');
    stop();
    expect(answered).toBeTrue();
    expect(opened).toEqual([[27, 'full']]);
    expect(s.mode()).toBe('full');
  });

  it('does not answer for a listener that declined the card - a card window must not take its own card back', async () => {
    const s = service();
    const stop = s.listen(() => false);
    const answered = await s.dock({ project: 'odeysys', cycleId: null, number: 27 }, 'side');
    stop();
    expect(answered).toBeFalse();
  });

  it('reports that nobody answered when no board tab listens', async () => {
    expect(await service().dock({ project: 'odeysys', cycleId: null, number: 27 }, 'side')).toBeFalse();
  });
});
