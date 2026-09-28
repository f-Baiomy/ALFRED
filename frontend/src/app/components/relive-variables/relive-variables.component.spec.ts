import { ComponentFixture, TestBed } from '@angular/core/testing';
import { CycleVariable, Step } from '../../shared/utils/relive-types';
import { ReliveVariablesComponent } from './relive-variables.component';

function variable(overrides: Partial<CycleVariable> = {}): CycleVariable {
  return { name: 'searchId', value: 'S-1', secret: false, note: null, ...overrides };
}

describe('ReliveVariablesComponent', () => {
  let fixture: ComponentFixture<ReliveVariablesComponent>;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [ReliveVariablesComponent] });
    fixture = TestBed.createComponent(ReliveVariablesComponent);
  });

  it('shows an empty state with no variables', () => {
    fixture.componentRef.setInput('variables', []);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('No variables yet.');
  });

  it('shows "defined" as the source for a variable no step extracts', () => {
    fixture.componentRef.setInput('variables', [variable()]);
    fixture.componentRef.setInput('steps', []);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('defined');
  });

  it('shows the extracting step and path as the source', () => {
    const step = { key: 's1', parentKey: null, label: 'Search', extract: [{ from: 'JSON', path: 'body.searchId', as: 'searchId', missing: 'SKIP' }] } as unknown as Step;
    fixture.componentRef.setInput('variables', [variable()]);
    fixture.componentRef.setInput('steps', [step]);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Search → body.searchId');
  });

  it('add() emits the list plus a new variable', () => {
    fixture.componentRef.setInput('variables', [variable()]);
    fixture.detectChanges();
    let emitted: readonly CycleVariable[] = [];
    fixture.componentInstance.variablesChange.subscribe((v: readonly CycleVariable[]) => (emitted = v));
    fixture.componentInstance.add();
    expect(emitted.length).toBe(2);
  });

  it('remove() emits the list without that variable', () => {
    fixture.componentRef.setInput('variables', [variable(), variable({ name: 'token' })]);
    fixture.detectChanges();
    let emitted: readonly CycleVariable[] = [];
    fixture.componentInstance.variablesChange.subscribe((v: readonly CycleVariable[]) => (emitted = v));
    fixture.componentInstance.remove('token');
    expect(emitted.map((v) => v.name)).toEqual(['searchId']);
  });

  it('hides the live column entirely when no run is active', () => {
    fixture.componentRef.setInput('variables', [variable()]);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).not.toContain('not set yet');
  });

  it('masks a secret live value until reveal is clicked', () => {
    fixture.componentRef.setInput('variables', [variable({ name: 'token', secret: true })]);
    fixture.componentRef.setInput('liveValues', { token: 'eyJhbGciOi9f2' });
    fixture.detectChanges();

    let text = fixture.nativeElement.textContent;
    expect(text).not.toContain('eyJhbGciOi9f2');
    expect(text).toContain('•••');

    fixture.componentInstance.toggleReveal('token');
    fixture.detectChanges();
    text = fixture.nativeElement.textContent;
    expect(text).toContain('eyJhbGciOi9f2');
  });

  it('shows "not set yet" for a live run where the variable has no value', () => {
    fixture.componentRef.setInput('variables', [variable()]);
    fixture.componentRef.setInput('liveValues', {});
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('not set yet');
  });
});
