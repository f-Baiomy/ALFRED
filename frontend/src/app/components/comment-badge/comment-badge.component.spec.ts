import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { CommentCount } from '../../core/models/comment.model';
import { CommentCountsState } from '../../core/state/comment-counts-state.service';
import { CommentBadgeComponent } from './comment-badge.component';

describe('CommentBadgeComponent', () => {
  const counts = signal<ReadonlyMap<string, CommentCount>>(new Map());
  const request = jasmine.createSpy('request');

  function render(callId: string) {
    TestBed.configureTestingModule({ imports: [CommentBadgeComponent], providers: [{ provide: CommentCountsState, useValue: { counts, request } }] });
    const fixture = TestBed.createComponent(CommentBadgeComponent);
    fixture.componentRef.setInput('callId', callId);
    fixture.detectChanges();
    return fixture;
  }

  it('shows the total and where the comments are', () => {
    counts.set(new Map([['a', { total: 4, byBlock: { call: 1, 'request-body': 2, 'response-body': 1 } }]]));
    const el: HTMLElement = render('a').nativeElement.querySelector('.comment-badge');
    expect(el.textContent).toContain('💬 4');
    expect(el.title).toBe('4 comments - 1 on the whole call, 2 on request body, 1 on response body');
    expect(request).toHaveBeenCalledWith('a');
  });

  it('renders nothing for a call without comments', () => {
    counts.set(new Map());
    expect(render('b').nativeElement.querySelector('.comment-badge')).toBeNull();
  });
});
