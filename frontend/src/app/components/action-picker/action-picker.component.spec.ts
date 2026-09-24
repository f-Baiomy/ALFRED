import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ACTION_LABELS, ActionType } from '../../core/models/interception.model';
import { ActionPick, ActionPickerComponent } from './action-picker.component';

describe('ActionPickerComponent', () => {
  let fixture: ComponentFixture<ActionPickerComponent>;
  let component: ActionPickerComponent;
  let picks: ActionPick[];
  let closed: number;

  const types: ActionType[] = ['DELAY_REQUEST', 'SET_REQUEST_HEADER', 'REPLACE_IN_REQUEST_BODY', 'MOCK_RESPONSE', 'SIMULATE_FAILURE', 'PAUSE_REQUEST'];

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [ActionPickerComponent] });
    fixture = TestBed.createComponent(ActionPickerComponent);
    component = fixture.componentInstance;
    picks = [];
    closed = 0;
    component.picked.subscribe((p) => picks.push(p));
    component.closed.subscribe(() => closed++);
    fixture.componentRef.setInput('phase', 'request');
    fixture.componentRef.setInput('types', types);
    fixture.componentRef.setInput('labels', ACTION_LABELS);
    fixture.componentRef.setInput('context', { topLevel: true, topLevelTypes: ['MOCK_RESPONSE'], bodyKind: 'xml' });
    fixture.componentRef.setInput('position', 'as step 2 of the request lane');
    fixture.detectChanges();
  });

  const text = () => (fixture.nativeElement as HTMLElement).textContent ?? '';
  const key = (k: string) => {
    fixture.nativeElement.querySelector('.ap-search input').dispatchEvent(new KeyboardEvent('keydown', { key: k }));
    fixture.detectChanges();
  };

  it('groups the actions, greys what the rule refuses with the reason, and tags what fits', () => {
    expect(text()).toContain('Timing');
    expect(text()).toContain('Answer instead of the host');
    const chips = [...fixture.nativeElement.querySelectorAll('.ap-chip')] as HTMLElement[];
    const failure = chips.find((c) => c.textContent!.includes('Simulate a failure'))!;
    expect(failure.closest('.ap-item')!.classList).toContain('off');
    expect(failure.title).toContain('already answers');
    expect(chips.find((c) => c.textContent!.includes('Find & replace'))!.textContent).toContain('fits this rule');

    failure.click();
    expect(picks).withContext('a refused action is never emitted').toEqual([]);

    // Every action carries its own ⓘ - the card's help - beside the chip, not inside it.
    const items = fixture.nativeElement.querySelectorAll('.ap-item');
    expect(items.length).toBe(types.length);
    for (const item of items) expect(item.querySelector('app-help-popover')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.ap-chip app-help-popover')).toBeNull();
  });

  it('searches, moves with the arrow keys, adds with Enter and closes with Esc', () => {
    component.setQuery('header');
    fixture.detectChanges();
    expect(component.items().map((i) => i.type)).toEqual(['SET_REQUEST_HEADER']);
    key('Enter');
    expect(picks).toEqual([{ kind: 'action', type: 'SET_REQUEST_HEADER' }]);

    component.setQuery('');
    key('ArrowDown');
    expect(component.current()?.type).toBe('SET_REQUEST_HEADER');
    expect(text()).toContain('Enter adds Set request header as step 2 of the request lane.');
    key('Escape');
    expect(closed).toBe(1);
  });

  it('highlights the first action whose name matches, before one matched only by its hint', () => {
    fixture.componentRef.setInput('types', ['SET_REQUEST_HEADER', 'DISABLE_CACHE', 'IF_REQUEST']);
    component.setQuery('condition');
    fixture.detectChanges();
    expect(component.items().map((i) => i.type)).toEqual(['DISABLE_CACHE', 'IF_REQUEST']);
    expect(component.current()?.type).toBe('IF_REQUEST');
  });

  it('narrows by goal, and hides recipes while searching', () => {
    component.setGoal('slow');
    fixture.detectChanges();
    expect(component.items().map((i) => i.type)).toEqual(['DELAY_REQUEST']);
    component.setGoal('all');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.ap-recipe')).not.toBeNull();
    component.setQuery('x');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.ap-recipe')).toBeNull();

    component.setQuery('');
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.ap-recipe') as HTMLElement).click();
    expect(picks[0].kind).toBe('recipe');
  });
});
