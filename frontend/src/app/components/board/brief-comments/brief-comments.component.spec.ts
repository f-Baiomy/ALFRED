import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { NEVER, of } from 'rxjs';
import { BriefComment, CycleBrief } from '../../../core/models/board.models';
import { BoardApiService } from '../../../core/services/board-api.service';
import { BoardSocketService } from '../../../core/services/board-socket.service';
import { BriefCommentsComponent } from './brief-comments.component';

function c(id: number, extra: Partial<BriefComment>): BriefComment {
  return { id, cycleId: 'cy', quote: null, actor: 'USER', text: 'x', replyTo: null, asks: false, suggestFrom: null, suggestTo: null,
    createdAt: '2026-10-12T10:00:00Z', resolvedAt: null, resolvedBy: null, ...extra };
}

const COMMENTS: BriefComment[] = [
  c(1, { quote: 'Branch is no longer required', text: 'Still true?' }),
  c(2, { replyTo: 1, actor: 'CLAUDE', text: 'Not yet - #52', suggestFrom: 'is no longer required', suggestTo: 'should not be required' }),
  c(3, { quote: 'All Branches', actor: 'CLAUDE', text: 'Include lost access?', asks: true }),
  c(4, { text: 'Keep the table in sync', resolvedAt: '2026-10-12T11:00:00Z', resolvedBy: 'USER' }),
];

describe('BriefCommentsComponent (specs/024)', () => {
  let api: jasmine.SpyObj<BoardApiService>;

  beforeEach(() => {
    api = jasmine.createSpyObj<BoardApiService>('BoardApiService', ['addBriefComment', 'briefCommentAction']);
    api.addBriefComment.and.returnValue(of({ comment: COMMENTS[0] }));
    TestBed.configureTestingModule({
      imports: [BriefCommentsComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), { provide: BoardApiService, useValue: api },
        { provide: BoardSocketService, useValue: { events$: NEVER } }],
    });
  });

  function render(editable = true, missing: Set<number> = new Set()) {
    const f = TestBed.createComponent(BriefCommentsComponent);
    f.componentRef.setInput('cycleId', 'cy');
    f.componentRef.setInput('project', 'p');
    f.componentRef.setInput('editable', editable);
    f.componentRef.setInput('comments', COMMENTS);
    f.componentRef.setInput('missing', missing);
    f.detectChanges();
    return f;
  }

  it('shows the open threads with their replies, Claude\'s question and suggestion, resolved ones folded', () => {
    const el: HTMLElement = render(true, new Set([3])).nativeElement;
    expect(el.querySelector('.tv-mh')?.textContent).toContain('2 open · 1 resolved');
    const threads = Array.from(el.querySelectorAll(':scope > .tv-cmt')) as HTMLElement[];
    expect(threads.map((t) => t.querySelector('.tv-q')?.textContent?.trim())).toEqual(['"Branch is no longer required"', '"All Branches" passage changed']);
    expect(threads[0].querySelector('.tv-rep')?.textContent).toContain('Not yet - #52');
    expect(threads[0].querySelector('.tv-proposal')?.textContent).toContain('is no longer required → should not be required');
    expect(threads[1].querySelector('.tv-asks')).not.toBeNull();
    expect(threads[1].querySelector('.tv-foot .board-link')?.textContent).toBe('Answer');
    expect(el.querySelector('details.tv-resolved summary')?.textContent).toContain('1 resolved');
  });

  it('Apply puts the rewording into the brief and hands the saved brief up; resolve and reopen are one click', () => {
    const brief: CycleBrief = { cycleId: 'cy', text: 'Branch should not be required', updatedAt: null };
    api.briefCommentAction.and.returnValue(of({ comment: COMMENTS[1], brief }));
    const f = render();
    const saved = jasmine.createSpy('saved');
    const changed = jasmine.createSpy('changed');
    f.componentInstance.briefSaved.subscribe(saved);
    f.componentInstance.changed.subscribe(changed);
    const el: HTMLElement = f.nativeElement;
    (el.querySelector('.tv-proposal .tv-accept') as HTMLButtonElement).click();
    expect(api.briefCommentAction).toHaveBeenCalledWith('cy', 2, 'apply');
    expect(saved).toHaveBeenCalledWith(brief);
    expect(changed).toHaveBeenCalled();
    (el.querySelector('.tv-res') as HTMLButtonElement).click();
    expect(api.briefCommentAction).toHaveBeenCalledWith('cy', 1, 'resolve');
    (Array.from(el.querySelectorAll('.tv-resolved .board-link')).find((b) => b.textContent === 'Reopen') as HTMLButtonElement).click();
    expect(api.briefCommentAction).toHaveBeenCalledWith('cy', 4, 'reopen');
  });

  it('a comment on the selected passage, or on the whole brief, is sent with its quote', () => {
    const f = render();
    f.componentInstance.draft.set('All Branches');
    f.detectChanges();
    const el: HTMLElement = f.nativeElement;
    expect(el.querySelector('.tv-draft .tv-q')?.textContent).toContain('"All Branches"');
    f.componentInstance.add('Why?');
    expect(api.addBriefComment).toHaveBeenCalledWith('cy', { quote: 'All Branches', text: 'Why?' });
    expect(f.componentInstance.draft()).toBeUndefined();
    f.detectChanges();

    (el.querySelector('.tv-mh .tv-btn') as HTMLButtonElement).click();
    f.detectChanges();
    expect(el.querySelector('.tv-draft .tv-q')?.textContent).toContain('On the whole brief');
    f.componentInstance.add('General');
    expect(api.addBriefComment).toHaveBeenCalledWith('cy', { quote: null, text: 'General' });

    f.componentInstance.reply(1, 'ok');
    expect(api.addBriefComment).toHaveBeenCalledWith('cy', { text: 'ok', replyTo: 1 });
  });

  it('read-only: no new comment, reply, resolve or apply', () => {
    const el: HTMLElement = render(false).nativeElement;
    expect(el.querySelector('.tv-mh .tv-btn')).toBeNull();
    expect(el.querySelector('.tv-foot')).toBeNull();
    expect(el.querySelector('.tv-proposal .tv-accept')).toBeNull();
  });
});
