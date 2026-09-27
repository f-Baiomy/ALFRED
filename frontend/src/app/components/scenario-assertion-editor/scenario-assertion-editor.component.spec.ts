import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ScenarioAssertionEditorComponent } from './scenario-assertion-editor.component';
import { Assertion } from '../../shared/utils/scenario-types';

describe('ScenarioAssertionEditorComponent', () => {
  let fixture: ComponentFixture<ScenarioAssertionEditorComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [ScenarioAssertionEditorComponent] }).compileComponents();
    fixture = TestBed.createComponent(ScenarioAssertionEditorComponent);
    fixture.componentRef.setInput('assertions', [{ kind: 'STATUS', operator: 'EQUALS', value: '200' }] satisfies Assertion[]);
    fixture.detectChanges();
  });

  it('renders one row per assertion', () => {
    const rows = fixture.nativeElement.querySelectorAll('.scenario-assertion-row');
    expect(rows.length).toBe(1);
  });

  it('emits an added assertion on "+ Add assertion"', () => {
    let emitted: readonly Assertion[] | null = null;
    fixture.componentInstance.assertionsChange.subscribe((v: readonly Assertion[]) => (emitted = v));
    const addBtn: HTMLButtonElement = fixture.nativeElement.querySelector('button.dialog-btn.secondary:not(.scenario-remove-btn)');
    addBtn.click();
    expect(emitted!.length).toBe(2);
  });

  it('emits a shorter list on remove', () => {
    let emitted: readonly Assertion[] | null = null;
    fixture.componentInstance.assertionsChange.subscribe((v: readonly Assertion[]) => (emitted = v));
    const removeBtn: HTMLButtonElement = fixture.nativeElement.querySelector('.scenario-remove-btn');
    removeBtn.click();
    expect(emitted).toBeTruthy();
    expect((emitted as readonly Assertion[] | null)?.length).toBe(0);
  });

  it('only shows a path field for JSON/HEADER kinds', () => {
    expect(fixture.componentInstance.needsPath('STATUS')).toBeFalse();
    expect(fixture.componentInstance.needsPath('JSON')).toBeTrue();
    expect(fixture.componentInstance.needsPath('HEADER')).toBeTrue();
    expect(fixture.componentInstance.needsPath('LATENCY')).toBeFalse();
  });

  it('hides the value field for EXISTS/NOT_EXISTS', () => {
    expect(fixture.componentInstance.needsValue('EXISTS')).toBeFalse();
    expect(fixture.componentInstance.needsValue('NOT_EXISTS')).toBeFalse();
    expect(fixture.componentInstance.needsValue('EQUALS')).toBeTrue();
  });
});
