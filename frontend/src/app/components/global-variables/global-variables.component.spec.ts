import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { GlobalVariablesComponent } from './global-variables.component';
import { GlobalVariablesService } from '../../core/services/global-variables.service';
import { AppConfigService } from '../../core/services/app-config.service';
import { BodyEditorComponent } from '../body-editor/body-editor.component';

describe('GlobalVariablesComponent input highlighting', () => {
  let component: GlobalVariablesComponent;
  let input: HTMLInputElement;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [{ provide: GlobalVariablesService, useValue: { load: jasmine.createSpy('load'), upsert: jasmine.createSpy('upsert'), watchForChanges: jasmine.createSpy('watchForChanges'), refresh: jasmine.createSpy('refresh') } }],
    });
    component = TestBed.runInInjectionContext(() => new GlobalVariablesComponent());
    input = document.createElement('input');
    input.type = 'text';
    input.value = 'prefix {{var}} suffix';
    document.body.append(input);
  });

  afterEach(() => input.remove());

  it('decorates tokens without hiding native input text or selection', () => {
    input.focus();
    component.onFocusIn({ target: input } as unknown as FocusEvent);
    expect(component.highlightedControl()).toBe(input);
    expect(input.classList.contains('variable-input-text-hidden')).toBeFalse();
    expect(component.highlightedParts().map((part) => part.text).join('')).toBe('prefix {{var}} suffix');

    input.value = 'changed {{var}} while focused';
    component.onInput({ target: input } as unknown as Event);
    expect(component.highlightedControl()).toBe(input);
    expect(component.highlightedParts().map((part) => part.text).join('')).toBe('changed {{var}} while focused');
    expect(component.highlightedParts().some((part) => part.token && part.text === '{{var}}')).toBeTrue();

    input.setSelectionRange(0, 6);
    component.onSelect({ target: input } as unknown as Event);
    expect(component.highlightedControl()).toBeNull();
    expect(input.classList.contains('variable-input-text-hidden')).toBeFalse();

    input.setSelectionRange(21, 21);
    component.onKeyUp({ target: input } as unknown as KeyboardEvent);
    expect(component.highlightedControl()).toBe(input);
    expect(input.classList.contains('variable-input-text-hidden')).toBeFalse();
  });

  it('keeps the writable selection when the floating button receives keyboard focus', () => {
    input.setSelectionRange(0, 6);
    component.onSelect({ target: input } as unknown as Event);
    expect(component.selectionCanReplace()).toBeTrue();
    component.beginSelectionCreate();
    const button = document.createElement('button');
    button.className = 'selection-variable-button';
    component.onKeyUp({ target: button } as unknown as KeyboardEvent);
    expect(component.selectionCanReplace()).toBeTrue();
    component.selectionName.set('saved');
    component.saveSelectionCreate();
    expect(input.value).toBe('{{saved}} {{var}} suffix');
  });

  it('clears the floating action when creation is cancelled', () => {
    input.setSelectionRange(0, 6);
    component.onSelect({ target: input } as unknown as Event);
    component.beginSelectionCreate();
    component.cancelSelectionCreate();
    const button = document.createElement('button');
    button.className = 'variable-modal-backdrop';
    component.onKeyUp({ target: button } as unknown as KeyboardEvent);
    expect(component.selectionText()).toBe('');
    expect(component.selectionCanReplace()).toBeFalse();
  });

  it('suggests only captures available on the current rule action, from data-local-variables on the input itself (contract C3)', () => {
    input.setAttribute('data-local-variables', JSON.stringify([
      { name: 'supplier', available: true },
      { name: 'code', available: true },
    ]));
    document.body.append(input);
    component.autocompleteControl.set(input);
    component.autocompleteQuery.set('this.s');
    expect(component.autocompleteMatches()).toEqual([{ name: 'this.supplier', value: 'Rule variable', available: true }]);
  });

  it('greys out an unavailable local variable with its reason, and does not let it be chosen', () => {
    input.setAttribute('data-local-variables', JSON.stringify([
      { name: 'supplier', available: false, reason: 'Set later in the chain' },
    ]));
    document.body.append(input);
    component.autocompleteControl.set(input);
    component.autocompleteQuery.set('this.');
    expect(component.autocompleteMatches()).toEqual([
      { name: 'this.supplier', value: 'Set later in the chain', available: false },
    ]);
  });

  it('lists local variables before global ones when the query does not start with "this."', () => {
    (component.variables as unknown as { entries: () => Array<{ name: string; value: string }> }).entries =
      () => [{ name: 'globalOne', value: 'x' }];
    input.setAttribute('data-local-variables', JSON.stringify([{ name: 'supplier', available: true }]));
    document.body.append(input);
    component.autocompleteControl.set(input);
    component.autocompleteQuery.set('');
    const names = component.autocompleteMatches().map((entry) => entry.name);
    expect(names[0]).toBe('this.supplier');
  });

  it('refetches when opened so promotions show without a page reload', () => {
    const variables = TestBed.inject(GlobalVariablesService) as unknown as { refresh: jasmine.Spy };
    expect(component.open()).toBeFalse();
    component.toggleOpen();
    expect(component.open()).toBeTrue();
    expect(variables.refresh).toHaveBeenCalledTimes(1);
    component.toggleOpen();
    expect(component.open()).toBeFalse();
    expect(variables.refresh).toHaveBeenCalledTimes(1);
  });
});

describe('GlobalVariablesComponent rendered input highlight', () => {
  it('keeps the native glyphs visible and paints only a token background', () => {
    TestBed.configureTestingModule({
      imports: [GlobalVariablesComponent],
      providers: [{ provide: GlobalVariablesService, useValue: { load: jasmine.createSpy('load'), watchForChanges: jasmine.createSpy('watchForChanges'), refresh: jasmine.createSpy('refresh') } }],
    });
    const fixture = TestBed.createComponent(GlobalVariablesComponent);
    fixture.detectChanges();
    const input = document.createElement('input');
    input.type = 'text';
    input.value = 'prefix {{var}} suffix';
    input.style.cssText = 'width:400px;font:16px Arial;color:rgb(234, 234, 245);padding:8px';
    document.body.append(input);
    try {
      const originalColor = getComputedStyle(input).color;
      input.focus();
      input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      fixture.detectChanges();

      const mirror = fixture.nativeElement.querySelector('.variable-input-highlight') as HTMLElement;
      const token = mirror.querySelector('.variable-highlight-token') as HTMLElement;
      expect(getComputedStyle(input).color).toBe(originalColor);
      expect(input.classList.contains('variable-input-text-hidden')).toBeFalse();
      expect(getComputedStyle(token).color).toBe('rgba(0, 0, 0, 0)');
      expect(mirror.textContent?.trim()).toBe(input.value);

      const reference = document.createElement('span');
      reference.textContent = '{{var}}';
      reference.style.cssText = 'font:16px Arial;white-space:pre';
      document.body.append(reference);
      try {
        expect(Math.abs(token.getBoundingClientRect().width - reference.getBoundingClientRect().width)).toBeLessThan(1);
      } finally {
        reference.remove();
      }

      input.setSelectionRange(0, input.value.length);
      input.dispatchEvent(new Event('select', { bubbles: true }));
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.variable-input-highlight')).toBeNull();
      expect(input.classList.contains('variable-input-text-hidden')).toBeFalse();
    } finally {
      input.remove();
      fixture.destroy();
    }
  });
});

describe('GlobalVariablesComponent the value card only opens over the variable', () => {
  let fixture: ComponentFixture<GlobalVariablesComponent>;
  let input: HTMLInputElement;

  /** Move the pointer to a point, the way a browser would, so the component's own listener runs. */
  const hover = (x: number, y: number) =>
    input.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }));

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [GlobalVariablesComponent],
      providers: [
        {
          provide: GlobalVariablesService,
          useValue: {
            load: jasmine.createSpy('load'),
            upsert: jasmine.createSpy('upsert'),
            watchForChanges: jasmine.createSpy('watchForChanges'),
            refresh: jasmine.createSpy('refresh'),
            // The card's own template reads the stored value, so a test that really renders it needs this.
            state: () => ({ variables: { code: '394' } }),
          },
        },
      ],
    });
    fixture = TestBed.createComponent(GlobalVariablesComponent);
    fixture.detectChanges();
    input = document.createElement('input');
    input.type = 'text';
    input.value = 'asdasa {{code}} asddwqweq';
    input.style.cssText = 'width:600px;font:16px Arial;padding:8px';
    document.body.append(input);
    input.focus();
    input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    fixture.detectChanges();
  });

  afterEach(() => {
    input.remove();
    fixture.destroy();
  });

  it('opens when the pointer is over the variable itself', () => {
    const token = fixture.nativeElement.querySelector('.variable-highlight-token') as HTMLElement;
    const rect = token.getBoundingClientRect();
    hover(rect.left + rect.width / 2, rect.top + rect.height / 2);
    expect(fixture.componentInstance.hoveredControl()).toBe(input);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.input-variable-hover')).not.toBeNull();
  });

  it('stays shut over the empty part of the field, past the end of the text', () => {
    // The reported bug: the pointer sat to the right of the text, in blank field, and the card
    // opened anyway - because the old test was "does the field's VALUE contain a token", which is
    // true wherever the pointer is.
    const field = input.getBoundingClientRect();
    hover(field.right - 20, field.top + field.height / 2);
    fixture.detectChanges();
    expect(fixture.componentInstance.hoveredControl()).toBeNull();
    expect(fixture.nativeElement.querySelector('.input-variable-hover')).toBeNull();
  });

  it('stays shut over the plain text beside the variable', () => {
    const token = fixture.nativeElement.querySelector('.variable-highlight-token') as HTMLElement;
    const field = input.getBoundingClientRect();
    // Well left of the token, still inside the field.
    hover(token.getBoundingClientRect().left - 30, field.top + field.height / 2);
    fixture.detectChanges();
    expect(fixture.componentInstance.hoveredControl()).toBeNull();
  });

  it('closes when the pointer slides off the variable but stays in the field', fakeAsync(() => {
    // mousemove matters here: moving within one input fires no new mouseover, so a
    // mouseover-only test would leave the card open after the pointer left the token.
    const token = fixture.nativeElement.querySelector('.variable-highlight-token') as HTMLElement;
    const on = token.getBoundingClientRect();
    hover(on.left + on.width / 2, on.top + on.height / 2);
    expect(fixture.componentInstance.hoveredControl()).toBe(input);
    hover(on.left - 40, on.top + on.height / 2);
    // Closing is a deliberate 220ms timer, so it is not immediate.
    expect(fixture.componentInstance.hoveredControl()).toBe(input);
    tick(221);
    expect(fixture.componentInstance.hoveredControl()).toBeNull();
  }));

  it('does not open for a field with no variable in it', () => {
    input.value = 'nothing to see';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    fixture.detectChanges();
    const field = input.getBoundingClientRect();
    hover(field.left + 10, field.top + field.height / 2);
    fixture.detectChanges();
    expect(fixture.componentInstance.hoveredControl()).toBeNull();
  });
});

describe('GlobalVariablesComponent inserting a variable into a body editor', () => {
  let overlay: ComponentFixture<GlobalVariablesComponent>;
  let editor: ComponentFixture<BodyEditorComponent>;
  let area: HTMLTextAreaElement;

  /** Type into the body editor the way a user would, so the overlay sees the same input event. */
  const type = (value: string, caret: number) => {
    area.focus();
    area.value = value;
    area.setSelectionRange(caret, caret);
    area.dispatchEvent(new Event('input', { bubbles: true }));
    editor.detectChanges();
    overlay.detectChanges();
  };

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [GlobalVariablesComponent, BodyEditorComponent],
      providers: [
        {
          provide: GlobalVariablesService,
          useValue: {
            load: jasmine.createSpy('load'),
            watchForChanges: jasmine.createSpy('watchForChanges'),
            refresh: jasmine.createSpy('refresh'),
            entries: () => [{ name: 'code', value: '394' }],
            state: () => ({ variables: { code: '394' }, fallbacks: {} }),
          },
        },
      ],
    });
    overlay = TestBed.createComponent(GlobalVariablesComponent);
    overlay.detectChanges();
    editor = TestBed.createComponent(BodyEditorComponent);
    editor.componentRef.setInput('value', '{"a":"heyjuada"}');
    // The rule editor feeds every edit straight back through [value] - patchMatchTest updates
    // the row, and the row feeds the binding. Without this round-trip the bug cannot show: the
    // thing that moves the caret is the binding writing the value the DOM already holds.
    editor.componentInstance.valueChange.subscribe((text) => editor.componentRef.setInput('value', text));
    editor.detectChanges();
    area = editor.nativeElement.querySelector('textarea');
  });

  afterEach(() => {
    overlay.destroy();
    editor.destroy();
  });

  it('leaves the caret just past the inserted token, not on the closing quote', () => {
    // The reported bug: after picking a variable the caret sat ON the closing quote, so the
    // next thing typed went outside the string and the JSON broke.
    type('{"a":"heyjuada{{"}', 16);
    const option = overlay.nativeElement.querySelector('[role="option"]') as HTMLButtonElement;
    expect(option).not.toBeNull();
    option.click();
    editor.detectChanges();

    expect(area.value).toBe('{"a":"heyjuada{{code}}"}');
    // 22 is just past "}}". 21 is the closing quote - where the caret used to land.
    expect(area.selectionStart).toBe(22);
    expect(area.selectionEnd).toBe(22);
  });

  it('emits the edit exactly once per change, so the parent stores the text that is on screen', () => {
    const seen: string[] = [];
    editor.componentInstance.valueChange.subscribe((text) => seen.push(text));
    type('{"a":"heyjuada{{"}', 16);
    // Typing the "{{" is one edit; accepting the suggestion is another. Each is emitted once -
    // the insert must not re-emit the text the editor already holds.
    expect(seen).toEqual(['{"a":"heyjuada{{"}']);
    (overlay.nativeElement.querySelector('[role="option"]') as HTMLButtonElement).click();
    expect(seen).toEqual(['{"a":"heyjuada{{"}', '{"a":"heyjuada{{code}}"}']);
  });

  it('reuses closing braces already typed in the JSON editor', () => {
    type('{"a":"heyjuada{{}}"}', 16);
    (overlay.nativeElement.querySelector('[role="option"]') as HTMLButtonElement).click();
    editor.detectChanges();

    expect(area.value).toBe('{"a":"heyjuada{{code}}"}');
    expect(area.selectionStart).toBe(22);
  });
});

describe('GlobalVariablesComponent duplicate name warning', () => {
  let component: GlobalVariablesComponent;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [{
        provide: GlobalVariablesService,
        useValue: {
          load: jasmine.createSpy('load'),
          upsert: jasmine.createSpy('upsert'),
          watchForChanges: jasmine.createSpy('watchForChanges'),
          refresh: jasmine.createSpy('refresh'),
          state: () => ({ variables: { code: '0123456789012345678901234567890123456789EXTRA' }, fallbacks: {} }),
        },
      }],
    });
    component = TestBed.runInInjectionContext(() => new GlobalVariablesComponent());
  });

  it('is empty with no name entered', () => {
    component.editName.set('');
    expect(component.duplicateNameWarning()).toBe('');
  });

  it('is empty for a name that does not exist yet', () => {
    component.editName.set('brandNew');
    expect(component.duplicateNameWarning()).toBe('');
  });

  it('warns, truncated to 40 chars, when the name already exists - and does not block saving', () => {
    component.editName.set('code');
    expect(component.duplicateNameWarning()).toBe('"code" exists (current: 0123456789012345678901234567890123456789…) — Save will overwrite');
    component.editValue.set('replacement');
    component.createOrUpdate();
    expect(component.variables.upsert).toHaveBeenCalledWith('code', 'replacement');
  });
});

describe('GlobalVariablesComponent duplicate name warning rendering', () => {
  it('renders the warning under the name field while the add form is open', () => {
    TestBed.configureTestingModule({
      imports: [GlobalVariablesComponent],
      providers: [{
        provide: GlobalVariablesService,
        useValue: {
          load: jasmine.createSpy('load'),
          watchForChanges: jasmine.createSpy('watchForChanges'),
          refresh: jasmine.createSpy('refresh'),
          error: () => '',
          saving: () => false,
          entries: () => [{ name: 'code', value: '0123456789012345678901234567890123456789EXTRA' }],
          state: () => ({ variables: { code: '0123456789012345678901234567890123456789EXTRA' }, fallbacks: {} }),
        },
      }],
    });
    const fixture: ComponentFixture<GlobalVariablesComponent> = TestBed.createComponent(GlobalVariablesComponent);
    fixture.detectChanges();
    fixture.componentInstance.open.set(true);
    fixture.componentInstance.editing.set(true);
    fixture.componentInstance.editName.set('code');
    fixture.detectChanges();
    const warning = fixture.nativeElement.querySelector('.variable-name-warning');
    expect(warning?.textContent).toContain('"code" exists');
    expect(warning?.textContent).toContain('Save will overwrite');
  });
});

describe('GlobalVariablesComponent grouping by source (B3)', () => {
  let component: GlobalVariablesComponent;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [{
        provide: GlobalVariablesService,
        useValue: {
          load: jasmine.createSpy('load'),
          watchForChanges: jasmine.createSpy('watchForChanges'),
          refresh: jasmine.createSpy('refresh'),
          entries: () => [
            { name: 'token', value: 'abc' },
            { name: 'accountId', value: '123' },
            { name: 'imported1', value: 'x' },
          ],
          state: () => ({
            variables: { token: 'abc', accountId: '123', imported1: 'x' },
            fallbacks: { removedName: 'null' },
            updatedAt: {},
            sources: {
              token: { kind: 'CAPTURE', ruleId: 'r-1', ruleName: 'Login token' },
              accountId: { kind: 'MANUAL' },
              imported1: { kind: 'IMPORT' },
            },
            secrets: [],
            activeEnvironment: 'Default',
            environments: ['Default'],
          }),
        },
      }],
    });
    component = TestBed.runInInjectionContext(() => new GlobalVariablesComponent());
  });

  it('buckets rows into Captured by rules / Set by hand / Imported / Deleted-fallback sections', () => {
    const sections = component.groupedSections();
    const byTitle = Object.fromEntries(sections.map((s) => [s.title, s.entries.map((e) => e.name)]));
    expect(byTitle['Captured by rules']).toEqual(['token']);
    expect(byTitle['Set by hand']).toEqual(['accountId']);
    expect(byTitle['Imported']).toEqual(['imported1']);
    expect(byTitle['Deleted, fallback still applies']).toEqual(['removedName']);
  });

  it('shows the capturing rule name for a CAPTURE row', () => {
    expect(component.ruleNameOf('token')).toBe('Login token');
    expect(component.ruleNameOf('accountId')).toBeNull();
  });

  it('filters rows across every section by name', () => {
    component.filterQuery.set('acc');
    const sections = component.groupedSections();
    const names = sections.flatMap((s) => s.entries.map((e) => e.name));
    expect(names).toEqual(['accountId']);
  });
});

describe('GlobalVariablesComponent secret masking (B4/D6)', () => {
  let component: GlobalVariablesComponent;
  let setSecretSpy: jasmine.Spy;

  beforeEach(() => {
    setSecretSpy = jasmine.createSpy('setSecret');
    TestBed.configureTestingModule({
      providers: [{
        provide: GlobalVariablesService,
        useValue: {
          load: jasmine.createSpy('load'),
          watchForChanges: jasmine.createSpy('watchForChanges'),
          refresh: jasmine.createSpy('refresh'),
          entries: () => [{ name: 'apiKey', value: 'shh' }, { name: 'accountId', value: '123' }],
          state: () => ({
            variables: { apiKey: 'shh', accountId: '123' }, fallbacks: {}, updatedAt: {}, sources: {},
            secrets: ['apiKey'], activeEnvironment: 'Default', environments: ['Default'],
          }),
          isSecret: (name: string) => name === 'apiKey' || /token|session|auth|key|password|secret/i.test(name),
          setSecret: setSecretSpy,
        },
      }],
    });
    component = TestBed.runInInjectionContext(() => new GlobalVariablesComponent());
  });

  it('masks a variable listed as secret, and one whose name matches the secret pattern', () => {
    expect(component.isMasked('apiKey')).toBeTrue();
    expect(component.isMasked('accountId')).toBeFalse();
  });

  it('toggles per-row reveal state independently of other rows', () => {
    expect(component.isRevealed('apiKey')).toBeFalse();
    component.toggleReveal('apiKey');
    expect(component.isRevealed('apiKey')).toBeTrue();
    expect(component.isRevealed('accountId')).toBeFalse();
    component.toggleReveal('apiKey');
    expect(component.isRevealed('apiKey')).toBeFalse();
  });

  it('marks/unmarks a variable as secret through the explicit list, not the name-pattern heuristic', () => {
    expect(component.isExplicitSecret('apiKey')).toBeTrue();
    expect(component.isExplicitSecret('accountId')).toBeFalse();
    component.toggleSecret('accountId');
    expect(setSecretSpy).toHaveBeenCalledWith('accountId', true);
  });
});

describe('GlobalVariablesComponent environments (C2)', () => {
  let component: GlobalVariablesComponent;
  let service: {
    switchEnvironment: jasmine.Spy; createEnvironment: jasmine.Spy; deleteEnvironment: jasmine.Spy;
    exportEnvironment: jasmine.Spy; import: jasmine.Spy; state: () => unknown; entries: () => unknown[];
  };

  beforeEach(() => {
    service = {
      switchEnvironment: jasmine.createSpy('switchEnvironment'),
      createEnvironment: jasmine.createSpy('createEnvironment'),
      deleteEnvironment: jasmine.createSpy('deleteEnvironment'),
      exportEnvironment: jasmine.createSpy('exportEnvironment'),
      import: jasmine.createSpy('import'),
      state: () => ({ variables: {}, fallbacks: {}, updatedAt: {}, sources: {}, secrets: [], activeEnvironment: 'Default', environments: ['Default', 'Staging'] }),
      entries: () => [],
    };
    TestBed.configureTestingModule({
      providers: [{
        provide: GlobalVariablesService,
        useValue: { load: jasmine.createSpy('load'), watchForChanges: jasmine.createSpy('watchForChanges'), refresh: jasmine.createSpy('refresh'), ...service },
      }],
    });
    component = TestBed.runInInjectionContext(() => new GlobalVariablesComponent());
  });

  it('switches environment on click, but not when it is already active', () => {
    component.switchEnv('Staging');
    expect(service.switchEnvironment).toHaveBeenCalledWith('Staging');
    component.switchEnv('Default');
    expect(service.switchEnvironment).toHaveBeenCalledTimes(1);
  });

  it('creates an environment with an optional copy-from source', () => {
    component.newEnvName.set('Prod');
    component.newEnvCopyFrom.set('Staging');
    component.confirmCreateEnv();
    expect(service.createEnvironment).toHaveBeenCalledWith('Prod', 'Staging');
  });

  it('rejects an invalid environment name', () => {
    component.newEnvName.set('bad name!');
    component.confirmCreateEnv();
    expect(service.createEnvironment).not.toHaveBeenCalled();
  });

  it('deletes an environment after confirmation', () => {
    component.confirmDeleteEnv('Staging');
    expect(component.deletingEnvironment()).toBe('Staging');
    component.doDeleteEnv();
    expect(service.deleteEnvironment).toHaveBeenCalledWith('Staging');
    expect(component.deletingEnvironment()).toBe('');
  });

  it('exports the active environment', () => {
    component.exportCurrent();
    expect(service.exportEnvironment).toHaveBeenCalledWith('Default', jasmine.any(Function));
  });

  it('imports the contract export shape as-is', () => {
    const payload = JSON.stringify({ environment: 'Staging', variables: { a: '1' }, fallbacks: { b: '2' } });
    const parsed = (component as unknown as { normalizeImportPayload: (raw: string) => { environment: string; variables: Record<string, string>; fallbacks?: Record<string, string> } }).normalizeImportPayload(payload);
    expect(parsed).toEqual({ environment: 'Staging', variables: { a: '1' }, fallbacks: { b: '2' } });
  });

  it('converts a Postman environment file, keeping only enabled values', () => {
    const postman = JSON.stringify({
      name: 'My Postman Env',
      values: [
        { key: 'a', value: '1', enabled: true },
        { key: 'b', value: '2', enabled: false },
        { key: 'c', value: '3' },
      ],
    });
    const parsed = (component as unknown as { normalizeImportPayload: (raw: string) => { environment: string; variables: Record<string, string>; fallbacks?: Record<string, string> } }).normalizeImportPayload(postman);
    expect(parsed).toEqual({ environment: 'My Postman Env', variables: { a: '1', c: '3' } });
  });

  it('rejects a file that matches neither shape', () => {
    const parsed = (component as unknown as { normalizeImportPayload: (raw: string) => unknown }).normalizeImportPayload('{"nonsense": true}');
    expect(parsed).toBeNull();
  });

  it('confirmImport() sends the chosen mode', () => {
    component.pendingImport.set({ environment: 'Staging', variables: { a: '1' } });
    component.importMode.set('REPLACE');
    component.confirmImport();
    expect(service.import).toHaveBeenCalledWith({ environment: 'Staging', variables: { a: '1' }, mode: 'REPLACE' });
  });
});

describe('GlobalVariablesComponent undo toast (C4)', () => {
  let component: GlobalVariablesComponent;
  let upsertSpy: jasmine.Spy;
  let removeSpy: jasmine.Spy;

  beforeEach(() => {
    upsertSpy = jasmine.createSpy('upsert');
    removeSpy = jasmine.createSpy('remove');
    TestBed.configureTestingModule({
      providers: [{
        provide: GlobalVariablesService,
        useValue: {
          load: jasmine.createSpy('load'),
          watchForChanges: jasmine.createSpy('watchForChanges'),
          refresh: jasmine.createSpy('refresh'),
          upsert: upsertSpy,
          remove: removeSpy,
          state: () => ({ variables: { name: 'old' }, fallbacks: {}, updatedAt: {}, sources: {}, secrets: [], activeEnvironment: 'Default', environments: ['Default'] }),
        },
      }],
    });
    component = TestBed.runInInjectionContext(() => new GlobalVariablesComponent());
  });

  it('offers undo after deleting a variable, restoring its previous value', () => {
    component.deleteVariable('name');
    component.confirmDelete();
    expect(component.lastUndo()?.label).toContain('Deleted');
    component.undo();
    expect(upsertSpy).toHaveBeenCalledWith('name', 'old');
    expect(component.lastUndo()).toBeNull();
  });

  it('offers undo after overwriting an existing variable value', () => {
    component.editName.set('name');
    component.editValue.set('new');
    component.createOrUpdate();
    expect(upsertSpy).toHaveBeenCalledWith('name', 'new');
    expect(component.lastUndo()?.label).toContain('Updated');
    component.undo();
    expect(upsertSpy).toHaveBeenCalledWith('name', 'old');
  });

  it('does not offer undo when adding a brand-new variable', () => {
    component.editName.set('brandNew');
    component.editValue.set('v');
    component.createOrUpdate();
    expect(component.lastUndo()).toBeNull();
  });
});

describe('GlobalVariablesComponent focusVariable / live-change flash (contract section 6)', () => {
  let fixture: ComponentFixture<GlobalVariablesComponent>;
  let http: HttpTestingController;
  let service: GlobalVariablesService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [GlobalVariablesComponent],
      providers: [
        provideHttpClient(), provideHttpClientTesting(),
        { provide: AppConfigService, useValue: { backendUrl: 'http://backend' } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(GlobalVariablesComponent);
    service = TestBed.inject(GlobalVariablesService);
    fixture.detectChanges();
    http.expectOne('http://backend/settings/variables').flush({ variables: {}, fallbacks: {} });
  });

  it('opens the drawer and flashes the row focusVariable() names', () => {
    service.focusVariable('accountId');
    fixture.detectChanges();
    expect(fixture.componentInstance.open()).toBeTrue();
    expect(fixture.componentInstance.flashedNames().has('accountId')).toBeTrue();
  });

  it('bumps the launch-tab badge for a remote change while the drawer is closed', () => {
    expect(fixture.componentInstance.open()).toBeFalse();
    service.upsert('name', 'one');
    http.expectOne('http://backend/settings/variables/name').flush({ variables: { name: 'one', other: 'promoted' }, fallbacks: {} });
    fixture.detectChanges();
    expect(fixture.componentInstance.badgeCount()).toBeGreaterThan(0);
  });
});
