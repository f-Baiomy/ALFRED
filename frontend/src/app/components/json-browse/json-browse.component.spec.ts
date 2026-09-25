import { ComponentFixture, TestBed } from '@angular/core/testing';
import { BrowsePick, JsonBrowseComponent } from './json-browse.component';

describe('JsonBrowseComponent', () => {
  let fixture: ComponentFixture<JsonBrowseComponent>;
  let component: JsonBrowseComponent;
  let picks: (readonly BrowsePick[])[];

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [JsonBrowseComponent] });
    fixture = TestBed.createComponent(JsonBrowseComponent);
    component = fixture.componentInstance;
    picks = [];
    component.picked.subscribe((p) => picks.push(p));
    fixture.componentRef.setInput('doc', { currency: 'EUR', passengers: [{ type: 'ADT' }, { type: 'CHD' }] });
    fixture.detectChanges();
  });

  it('shows lists once as [*], folds, and hands over ticked fields as tests or edits with their values', () => {
    const text = () => (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text()).toContain('[2 items]');
    expect(component.visible().map((r) => r.entry.path)).toEqual(['currency', 'passengers', 'passengers[*].type']);

    component.toggleFold('passengers');
    expect(component.visible().map((r) => r.entry.path)).toEqual(['currency', 'passengers']);
    component.toggleFold('passengers');

    component.tick('currency', true);
    component.tick('passengers[*].type', true);
    component.setMode('currency', 'change');
    component.add();
    expect(picks[0]).toEqual([
      { path: 'currency', value: 'EUR', as: 'change', type: 'text' },
      { path: 'passengers[*].type', value: 'ADT', as: 'test', type: 'text' },
    ]);
    expect(component.ticked().size).toBe(0);
  });
});
