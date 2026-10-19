import { provideLinksTesting } from '../../../core/links/links-testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MentionRef } from '../../../core/models/board.models';
import { BoardMentionsService, LiveMention, labelStatus } from '../../../core/services/board-mentions.service';
import { MentionChipComponent } from './mention-chip.component';
import { groupCalls } from './mention-group.component';

describe('MentionChipComponent (specs/021 readable references)', () => {
  function chip(ref: MentionRef, live: LiveMention | null): HTMLElement {
    TestBed.configureTestingModule({ imports: [MentionChipComponent],
      providers: [...provideLinksTesting(), { provide: BoardMentionsService, useValue: { live: () => signal(live), preview: () => ({ subscribe: () => undefined }) } }] });
    const fixture = TestBed.createComponent(MentionChipComponent);
    fixture.componentRef.setInput('mention', ref);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('reads what the reference means now, with a dot for its state', () => {
    const el = chip({ type: 'spec', ref: 'c1/*#ac8', label: 'AC8' }, { label: 'one-branch search (AC8)', tone: 'warn', state: 'Not exercised' });
    expect(el.textContent).toContain('one-branch search (AC8)');
    const dot = el.querySelector('.board-mention-dot') as HTMLElement;
    expect(dot.classList).toContain('dot-warn');
    expect(dot.title).toBe('Not exercised');
  });

  it('keeps the saved label until the look-up answers', () => {
    const el = chip({ type: 'card', ref: 'p#47', label: 'All Agencies untested (#47)' }, null);
    expect(el.textContent).toContain('All Agencies untested (#47)');
    expect(el.querySelector('.board-mention-dot')).toBeNull();
  });
});

describe('groupCalls', () => {
  const call = (id: string, label = `POST /x · 200`) => ({ kind: 'mention', ref: { type: 'call', ref: `in:${id}`, label } as MentionRef });
  const text = (t: string) => ({ kind: 'text', text: t });
  const refOf = (n: { kind: string; ref?: MentionRef }) => n.ref ?? null;

  it('three or more calls joined by commas and "and" are one group', () => {
    const out = groupCalls([text('calls '), call('a'), text(', '), call('b'), text(' and '), call('c'), text(' sent 3 branches')], refOf);
    expect(out.length).toBe(3);
    expect((out[1] as { kind: string; refs: MentionRef[] }).refs.map((r) => r.ref)).toEqual(['in:a', 'in:b', 'in:c']);
  });

  it('two calls, or calls with words between them, stay as they are', () => {
    expect(groupCalls([call('a'), text(', '), call('b')], refOf).length).toBe(3);
    expect(groupCalls([call('a'), text(' then '), call('b'), text(' then '), call('c')], refOf).length).toBe(5);
  });
});

describe('labelStatus', () => {
  it('reads the status after the dot, never a cycle call number', () => {
    expect(labelStatus('POST /orders · 500')).toBe('500');
    expect(labelStatus('POST refunded-requests/search · 200 (call 75)')).toBe('200');
    expect(labelStatus('GET orders (call 500)')).toBeUndefined();
    expect(labelStatus('POST /orders/404/items')).toBeUndefined();
  });
});
