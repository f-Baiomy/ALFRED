import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { HeaderEditorComponent } from './header-editor.component';
import { BodyEditorComponent } from '../body-editor/body-editor.component';
import { HeaderRow } from '../../shared/utils/header-rows';

@Component({
  standalone: true,
  imports: [HeaderEditorComponent],
  template: `<app-header-editor [headers]="rows()" [readOnly]="readOnly()" (headersChange)="onChange($event)" />`,
})
class HostComponent {
  readonly rows = signal<readonly HeaderRow[]>([]);
  readonly readOnly = signal(false);
  readonly emitted: HeaderRow[][] = [];

  onChange(rows: HeaderRow[]): void {
    this.emitted.push(rows);
    this.rows.set(rows);
  }
}

const row = (name: string, value: string, extra: Partial<HeaderRow> = {}): HeaderRow => ({
  name,
  value,
  removed: false,
  ...extra,
});

describe('HeaderEditorComponent', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;

  function setup(rows: HeaderRow[], readOnly = false): HeaderEditorComponent {
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    host.rows.set(rows);
    host.readOnly.set(readOnly);
    fixture.detectChanges();
    return fixture.debugElement.query(By.directive(HeaderEditorComponent)).componentInstance;
  }

  const last = () => host.emitted[host.emitted.length - 1];
  const input = (value: string) => ({ target: { value } }) as unknown as Event;

  describe('rows', () => {
    it('emits a name or value edit', () => {
      const editor = setup([row('a', '1')]);

      editor.onValue(0, input('2'));
      expect(last()).toEqual([row('a', '2')]);

      editor.onName(0, input('b'));
      expect(last()).toEqual([row('b', '2')]);
    });

    it('strikes a removed row through rather than dropping it, and can bring it back', () => {
      const editor = setup([row('a', '1')]);

      editor.toggleRemoved(0);
      expect(last()).toEqual([row('a', '1', { removed: true })]);

      editor.toggleRemoved(0);
      expect(last()).toEqual([row('a', '1')]);
    });

    it('adds a blank row flagged as added, which goes entirely when removed', () => {
      const editor = setup([]);

      editor.addRow();
      expect(last()).toEqual([{ name: '', value: '', removed: false, added: true }]);

      editor.toggleRemoved(0);
      expect(last()).toEqual([]);
    });

    it('renders struck-through and added rows with their classes', () => {
      setup([row('a', '1', { removed: true }), row('b', '2', { added: true })]);
      const rows = fixture.nativeElement.querySelectorAll('.header-editor-row');

      expect(rows[0].classList).toContain('removed');
      expect(rows[1].classList).toContain('added');
    });

    it('offers no remove or add when read-only', () => {
      setup([row('a', '1')], true);
      const el = fixture.nativeElement as HTMLElement;

      expect(el.querySelector('.header-editor-row .icon-btn')).toBeNull();
      expect(el.textContent).not.toContain('+ Add header');
    });
  });

  describe('JSON', () => {
    it('shows only the headers still being sent, as a pretty object', () => {
      const editor = setup([row('a', '1'), row('gone', 'x', { removed: true })]);
      editor.setView('json');

      expect(editor.jsonText()).toBe('{\n  "a": "1"\n}');
    });

    it('round-trips an edit: changed, deleted and new names', () => {
      const editor = setup([row('a', '1'), row('b', '2'), row('mine', 'm', { added: true })]);
      editor.setView('json');
      fixture.detectChanges();
      const body = fixture.debugElement.query(By.directive(BodyEditorComponent)).componentInstance as BodyEditorComponent;

      body.onBodyInput({ target: { value: '{"a":"10","c":"3"}' } } as unknown as Event);

      expect(last()).toEqual([
        { name: 'a', value: '10', removed: false, added: false },
        // b was sent before and is now missing: removed, struck through.
        { name: 'b', value: '2', removed: true, added: false },
        // mine was added by hand and is gone: it never existed.
        { name: 'c', value: '3', removed: false, added: true },
      ]);

      // Back in Rows, the same rows are on screen.
      fixture.detectChanges();
      editor.setView('rows');
      expect(editor.rows()).toEqual(last());
      // And the draft typed is still what the JSON view shows, not a re-indented copy of it.
      editor.setView('json');
      expect(editor.jsonText()).toBe('{"a":"10","c":"3"}');
    });

    it('does not emit invalid JSON, and says so', () => {
      const editor = setup([row('a', '1')]);
      editor.setView('json');
      fixture.detectChanges();

      editor.onJson('{"a": ');
      fixture.detectChanges();

      expect(host.emitted).toEqual([]);
      expect(editor.jsonError()).toBe('Not valid JSON - not applied');
      expect(editor.jsonText()).toBe('{"a": ');
      expect(fixture.nativeElement.querySelector('.header-editor-json-error').textContent).toContain('Not valid JSON');
    });

    it('refuses a value that is not text', () => {
      const editor = setup([row('a', '1')]);

      editor.onJson('{"a":{"nested":true}}');

      expect(host.emitted).toEqual([]);
      expect(editor.jsonError()).toContain('not applied');
    });

    it('does not emit a whitespace-only change', () => {
      const editor = setup([row('a', '1')]);

      editor.onJson('{ "a" : "1" }');

      expect(host.emitted).toEqual([]);
    });
  });
});
