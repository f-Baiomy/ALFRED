import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { By } from '@angular/platform-browser';
import { EditViewPageComponent } from './edit-view-page.component';
import { EditTabMessage, EditTabSeed, EditTabService } from '../../core/services/edit-tab.service';
import { BodyEditorComponent } from '../../components/body-editor/body-editor.component';
import { HeaderEditorComponent } from '../../components/header-editor/header-editor.component';
import { parseHeaderRows, serializeHeaderRows } from '../../shared/utils/header-rows';

describe('EditViewPageComponent', () => {
  let posted: EditTabMessage[];
  let stored: EditTabSeed[];
  let seed: EditTabSeed | null;

  function create(key: string | null) {
    posted = [];
    stored = [];
    const fake: Partial<EditTabService> = {
      readSeed: () => seed,
      store: (_key, s) => void stored.push(s),
      publisher: () => ({ post: (m) => void posted.push(m), close: () => undefined }),
    };
    TestBed.configureTestingModule({
      imports: [EditViewPageComponent],
      providers: [
        { provide: EditTabService, useValue: fake },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap(key ? { key } : {}) } } },
      ],
    });
    const fixture = TestBed.createComponent(EditViewPageComponent);
    fixture.detectChanges();
    return fixture;
  }

  it('says the editor expired when there is no seed', () => {
    seed = null;
    const fixture = create('k1');

    expect(fixture.componentInstance.expired()).toBeTrue();
    expect(fixture.nativeElement.querySelector('.panel-view-expired')).not.toBeNull();
  });

  it('says so with no key at all', () => {
    seed = { kind: 'body', title: 'x', value: '' };
    expect(create(null).componentInstance.expired()).toBeTrue();
  });

  it('edits a body and posts every change back, re-storing it for a reload', () => {
    seed = { kind: 'body', title: 'Response body', value: '{"a":1}' };
    const fixture = create('k1');
    const editor = fixture.debugElement.query(By.directive(BodyEditorComponent)).componentInstance as BodyEditorComponent;

    expect(editor.text()).toBe('{"a":1}');
    expect(fixture.nativeElement.querySelector('h1').textContent).toContain('Response body');

    editor.onBodyInput({ target: { value: '{"a":2}' } } as unknown as Event);

    expect(posted).toEqual([{ type: 'value', value: '{"a":2}' }]);
    expect(stored[0].value).toBe('{"a":2}');
  });

  it('edits headers in the JSON view first and posts serialized rows', () => {
    seed = { kind: 'headers', title: 'Headers', value: serializeHeaderRows([{ name: 'a', value: '1', removed: false }]) };
    const fixture = create('k1');
    const headers = fixture.debugElement.query(By.directive(HeaderEditorComponent)).componentInstance as HeaderEditorComponent;

    expect(headers.view()).toBe('json');

    headers.onJson('{"a":"2"}');

    expect(posted.length).toBe(1);
    const message = posted[0] as { type: 'value'; value: string };
    expect(parseHeaderRows(message.value)).toEqual([{ name: 'a', value: '2', removed: false, added: false }]);
  });

  it('treats a headers seed that is not the row list as expired', () => {
    seed = { kind: 'headers', title: 'Headers', value: '{"a":"1"}' };
    expect(create('k1').componentInstance.expired()).toBeTrue();
  });

  it('posts closed and shuts the tab on Done', () => {
    seed = { kind: 'body', title: 'Body', value: '' };
    const close = spyOn(window, 'close');
    const fixture = create('k1');

    fixture.componentInstance.done();

    expect(posted).toEqual([{ type: 'closed' }]);
    expect(close).toHaveBeenCalled();
  });
});
