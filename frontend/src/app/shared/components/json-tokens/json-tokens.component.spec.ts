import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { HighlightToken } from '../../utils/json-tokenizer';
import { GlobalVariablesService } from '../../../core/services/global-variables.service';
import { JsonTokensComponent } from './json-tokens.component';

const plain = (text: string): HighlightToken => ({ text, highlighted: false, cls: '' });
const variable = (text: string): HighlightToken => ({ text, highlighted: false, cls: '', variableToken: true });

/** A body containing one variable. */
const tokens: HighlightToken[] = [plain('{"code":'), variable('{{code}}'), plain('}')];

describe('JsonTokensComponent variable hover card', () => {
  let fixture: ComponentFixture<JsonTokensComponent>;
  let mark: HTMLElement;
  const card = () => fixture.nativeElement.querySelector('.variable-hover-card') as HTMLElement | null;
  const textarea = () => fixture.nativeElement.querySelector('.variable-hover-card textarea') as HTMLTextAreaElement | null;
  const open = () => {
    mark.dispatchEvent(new MouseEvent('mouseenter'));
    tick(450);
    fixture.detectChanges();
  };

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [JsonTokensComponent],
      providers: [
        { provide: GlobalVariablesService, useValue: { state: () => ({ variables: { code: '394' } }), upsert: () => {} } },
      ],
    });
    fixture = TestBed.createComponent(JsonTokensComponent);
    fixture.componentRef.setInput('tokens', tokens);
    fixture.detectChanges();
    mark = fixture.debugElement.query(By.css('mark.variable-token')).nativeElement as HTMLElement;
  });

  it('waits for the pointer to settle on the variable before showing anything', fakeAsync(() => {
    expect(card()).toBeNull();
    mark.dispatchEvent(new MouseEvent('mouseenter'));
    tick(449);
    fixture.detectChanges();
    expect(card()).toBeNull();
    tick(1);
    fixture.detectChanges();
    expect(card()).not.toBeNull();
  }));

  it('listens on the variable token, not on the wrapper the card also lives in', fakeAsync(() => {
    // The regression this guards: the trigger used to sit on the wrapper, so anything the card
    // happened to be covering counted as hovering the variable and opened it.
    const markDebug = fixture.debugElement.query(By.css('mark.variable-token'));
    const wrapDebug = fixture.debugElement.query(By.css('.variable-hover-wrap'));
    expect(markDebug.listeners.map((l) => l.name)).toContain('mouseenter');
    expect(wrapDebug.listeners.map((l) => l.name)).not.toContain('mouseenter');
  }));

  it('does not open when something other than the token is hovered', fakeAsync(() => {
    // Nothing else in the list carries a hover handler at all.
    const otherListeners = fixture.debugElement
      .queryAll(By.css('.br-row, textarea, input'))
      .flatMap((d) => d.listeners.map((l) => l.name));
    expect(otherListeners.filter((n) => n === 'mouseenter')).toEqual([]);
    expect(card()).toBeNull();
  }));

  it('is pointer-transparent, so the field it floats over stays clickable', fakeAsync(() => {
    open();
    expect(getComputedStyle(card()!).pointerEvents).toBe('none');
    // The textarea is the one part that has to take the pointer - it is how the value is edited.
    expect(getComputedStyle(textarea()!).pointerEvents).toBe('auto');
  }));

  it('stays open while the pointer is on its textarea, so the value can be edited', fakeAsync(() => {
    open();
    // Leaving the token starts the close timer, as it must.
    mark.dispatchEvent(new MouseEvent('mouseleave'));
    tick(100);
    // Arriving on the textarea cancels it: the gap between token and card makes this unavoidable,
    // and without it the card would close before the pointer ever got there.
    textarea()!.dispatchEvent(new MouseEvent('mouseenter'));
    tick(500);
    fixture.detectChanges();
    expect(card()).not.toBeNull();
  }));

  it('closes once the pointer leaves the textarea', fakeAsync(() => {
    open();
    mark.dispatchEvent(new MouseEvent('mouseleave'));
    textarea()!.dispatchEvent(new MouseEvent('mouseenter'));
    textarea()!.dispatchEvent(new MouseEvent('mouseleave'));
    tick(219);
    fixture.detectChanges();
    expect(card()).not.toBeNull();
    tick(1);
    fixture.detectChanges();
    expect(card()).toBeNull();
  }));

  it('names the variable it was opened on and shows its saved value', fakeAsync(() => {
    open();
    expect(card()!.textContent).toContain('{{code}}');
    expect(textarea()!.value).toBe('394');
  }));
});
