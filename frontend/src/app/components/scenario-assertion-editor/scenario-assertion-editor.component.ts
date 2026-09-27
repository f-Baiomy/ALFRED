import { Component, input, output } from '@angular/core';
import { Assertion } from '../../shared/utils/scenario-types';

type AssertionKind = Assertion['kind'];
type AssertionOperator = Assertion['operator'];

const KINDS: readonly AssertionKind[] = ['STATUS', 'JSON', 'HEADER', 'LATENCY'];
const OPERATORS: readonly AssertionOperator[] = ['EQUALS', 'NOT_EQUALS', 'EXISTS', 'NOT_EXISTS', 'CONTAINS', 'GT', 'LT', 'MATCHES'];

function defaultAssertion(): Assertion {
  return { kind: 'STATUS', operator: 'EQUALS', value: '200' };
}

/**
 * D1 - the list of assertions attached to one draft. Purely a form over `Assertion[]`
 * (contracts.md section 6); evaluation itself lives in shared/utils/scenario-assertions.ts.
 */
@Component({
  selector: 'app-scenario-assertion-editor',
  standalone: true,
  templateUrl: './scenario-assertion-editor.component.html',
})
export class ScenarioAssertionEditorComponent {
  readonly assertions = input.required<readonly Assertion[]>();
  readonly assertionsChange = output<readonly Assertion[]>();

  readonly kinds = KINDS;
  readonly operators = OPERATORS;

  needsPath(kind: AssertionKind): boolean {
    return kind === 'JSON' || kind === 'HEADER';
  }

  needsValue(operator: AssertionOperator): boolean {
    return operator !== 'EXISTS' && operator !== 'NOT_EXISTS';
  }

  pathLabel(kind: AssertionKind): string {
    return kind === 'JSON' ? 'JSON path' : 'Header name';
  }

  add(): void {
    this.assertionsChange.emit([...this.assertions(), defaultAssertion()]);
  }

  updateKind(index: number, kind: string): void {
    this.patch(index, { kind: kind as AssertionKind });
  }

  updateOperator(index: number, operator: string): void {
    this.patch(index, { operator: operator as AssertionOperator });
  }

  updatePath(index: number, path: string): void {
    this.patch(index, { path });
  }

  updateValue(index: number, value: string): void {
    this.patch(index, { value });
  }

  remove(index: number): void {
    this.assertionsChange.emit(this.assertions().filter((_, i) => i !== index));
  }

  private patch(index: number, patch: Partial<Assertion>): void {
    this.assertionsChange.emit(this.assertions().map((a, i) => (i === index ? { ...a, ...patch } : a)));
  }
}
