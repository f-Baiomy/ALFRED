import { ComponentFixture, TestBed } from '@angular/core/testing';
import { HelpEntry } from '../../shared/utils/interception-help';
import { HelpPopoverComponent } from './help-popover.component';

describe('HelpPopoverComponent', () => {
  let fixture: ComponentFixture<HelpPopoverComponent>;
  let component: HelpPopoverComponent;

  const entry = (overrides: Partial<HelpEntry> = {}): HelpEntry => ({
    title: 'Request JSON field',
    code: 'REQUEST_JSON_FIELD',
    what: 'Parses the request body as JSON and reads one field.',
    examples: [{ from: 'supplier', to: '"TravelportNdc"' }],
    warning: 'A body that is not JSON behaves as absent.',
    ...overrides,
  });

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [HelpPopoverComponent] }).compileComponents();
    fixture = TestBed.createComponent(HelpPopoverComponent);
    component = fixture.componentInstance;
  });

  function render(entries: HelpEntry[], summary = ''): void {
    fixture.componentRef.setInput('entries', entries);
    fixture.componentRef.setInput('summary', summary);
    fixture.detectChanges();
  }

  const text = () => (fixture.nativeElement as HTMLElement).textContent ?? '';

  it('shows nothing until it is asked', () => {
    // A panel open by default would bury the field it is explaining.
    render([entry()]);

    expect(text()).not.toContain('Parses the request body');
  });

  it('opens on click with the explanation, examples and warning', () => {
    render([entry()]);

    component.toggle(new MouseEvent('click'));
    fixture.detectChanges();

    expect(text()).toContain('Parses the request body');
    expect(text()).toContain('supplier');
    expect(text()).toContain('"TravelportNdc"');
    expect(text()).toContain('not JSON behaves as absent');
  });

  it('shows every entry it is given, because a condition is a subject AND an operator', () => {
    render([entry(), entry({ title: 'equals', code: 'EQUALS', what: 'The whole value, not a part of it.' })]);

    component.toggle(new MouseEvent('click'));
    fixture.detectChanges();

    expect(text()).toContain('Request JSON field');
    expect(text()).toContain('equals');
    expect(text()).toContain('The whole value');
  });

  it('closes the panel again', () => {
    render([entry()]);
    component.toggle(new MouseEvent('click'));
    fixture.detectChanges();

    component.close();
    fixture.detectChanges();

    expect(text()).not.toContain('Parses the request body');
  });

  it('restates the control in the words the call log uses', () => {
    render([entry()], 'Request JSON field supplier equals TravelportNdc');

    component.toggle(new MouseEvent('click'));
    fixture.detectChanges();

    expect(text()).toContain('This one, right now');
    expect(text()).toContain('Request JSON field supplier equals TravelportNdc');
  });

  it('omits an entry that genuinely has no warning rather than inventing one', () => {
    render([entry({ warning: undefined })]);

    component.toggle(new MouseEvent('click'));
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.help-warning')).toBeNull();
  });

  it('sits on a solid surface, not a translucent one', () => {
    // Glass themes make every other surface variable an rgba over the page background. That is
    // right for a card resting on the page and unreadable for a panel of dense text resting on
    // the rule you are in the middle of editing - which is exactly how this shipped first.
    render([entry()]);
    component.toggle(new MouseEvent('click'));
    fixture.detectChanges();

    const panel = fixture.nativeElement.querySelector('.help-panel') as HTMLElement;
    expect(panel.style.getPropertyValue('background') || getComputedStyle(panel).background)
      .not.toContain('rgba');
  });
});
