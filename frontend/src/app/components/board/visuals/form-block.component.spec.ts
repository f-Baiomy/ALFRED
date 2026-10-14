import { TestBed } from '@angular/core/testing';
import { BoardActionsService } from '../../../core/services/board-actions.service';
import { FormBlockComponent, formAnswer, parseForm } from './form-block.component';

describe('form block', () => {
  it('reads title, fields and submit', () => {
    const f = parseForm('title: Which fix?\nfield: approach | Approach | select: Per rule, Per session\nfield: ok | Tested | check\nsubmit: Send');
    expect(f.error).toBeNull();
    expect(f.title).toBe('Which fix?');
    expect(f.fields.map((x) => x.type)).toEqual(['select', 'check']);
    expect(f.fields[0].options).toEqual(['Per rule', 'Per session']);
    expect(f.submit).toBe('Send');
  });

  it('says what is wrong with a bad line', () => {
    expect(parseForm('hello').error).toMatch(/title:, field: or submit:/);
    expect(parseForm('field: a b | x').error).toMatch(/a word/);
    expect(parseForm('field: a | x | date').error).toMatch(/its type is/);
    expect(parseForm('title: only').error).toMatch(/at least one field/);
  });

  it('answers as name=value; pairs, a ; inside a value cannot add a field', () => {
    const f = parseForm('field: a | A\nfield: ok | OK | check').fields;
    expect(formAnswer(f, { a: 'x; ok=yes', ok: false })).toBe('a=x, ok=yes; ok=no');
  });

  it('posts the answer through the consent of BoardActionsService; never from a preview', async () => {
    const perform = jasmine.createSpy('perform').and.resolveTo(true);
    TestBed.configureTestingModule({ imports: [FormBlockComponent], providers: [{ provide: BoardActionsService, useValue: { perform } }] });
    const fx = TestBed.createComponent(FormBlockComponent);
    fx.componentRef.setInput('source', 'field: note | Note');
    fx.componentRef.setInput('context', { cardId: 'c1' });
    fx.componentRef.setInput('canSend', false);
    fx.detectChanges();
    await fx.componentInstance.send();
    expect(perform).not.toHaveBeenCalled();
    fx.componentRef.setInput('canSend', true);
    fx.componentInstance.set('note', 'fine');
    await fx.componentInstance.send();
    expect(perform).toHaveBeenCalledOnceWith('answer', { text: 'note=fine' }, { cardId: 'c1' }, 'This form');
    fx.detectChanges();
    expect(fx.nativeElement.textContent).toContain('Sent as your answer');
  });
});
