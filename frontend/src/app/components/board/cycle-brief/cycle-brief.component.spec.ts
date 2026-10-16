import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { Subject, of } from 'rxjs';
import { BriefComment, CycleBrief } from '../../../core/models/board.models';
import { BoardApiService } from '../../../core/services/board-api.service';
import { BoardSocketService } from '../../../core/services/board-socket.service';
import { CycleBriefComponent } from './cycle-brief.component';

const BRIEF: CycleBrief = { cycleId: 'cy', updatedAt: '2026-10-16T10:00:00Z', hasPrevious: false,
  text: 'Filters get All Branches.\n\n## Scope\n- Branch is no longer required\n- Export uses the filters\n\n## Test steps\n1. Open the page\n\n## Data\n- Cairo\n' };

const c = (id: number, extra: Partial<BriefComment>): BriefComment => ({ id, cycleId: 'cy', quote: null, actor: 'USER', text: 'x', replyTo: null,
  asks: false, suggestFrom: null, suggestTo: null, createdAt: '2026-10-16T10:00:00Z', resolvedAt: null, resolvedBy: null, ...extra });

describe('CycleBriefComponent - brief and its comments (specs/024)', () => {
  let api: jasmine.SpyObj<BoardApiService>;
  let events: Subject<unknown>;

  beforeEach(() => {
    api = jasmine.createSpyObj<BoardApiService>('BoardApiService', ['brief', 'briefComments', 'putBrief', 'restoreBrief', 'addBriefComment', 'briefCommentAction']);
    api.brief.and.returnValue(of(BRIEF));
    api.briefComments.and.returnValue(of([c(1, { quote: 'Branch is no longer required' }), c(2, { quote: 'a passage edited away' })]));
    events = new Subject();
    TestBed.configureTestingModule({
      imports: [CycleBriefComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), { provide: BoardApiService, useValue: api },
        { provide: BoardSocketService, useValue: { events$: events } }],
    });
  });

  async function render() {
    const f = TestBed.createComponent(CycleBriefComponent);
    f.componentRef.setInput('cycleId', 'cy');
    f.componentRef.setInput('project', '');
    document.body.appendChild(f.nativeElement);
    f.detectChanges();
    await f.whenStable();
    f.detectChanges();
    await new Promise((r) => setTimeout(r, 200));
    f.detectChanges();
    return f;
  }

  it('shows the brief by section, with its test steps and data, and the comments beside it', async () => {
    const f = await render();
    const el: HTMLElement = f.nativeElement;
    expect(el.querySelector('.tv-bbody')?.textContent).toContain('Branch is no longer required');
    expect(el.querySelector('.tv-bbody')?.textContent).toContain('Open the page');
    expect(el.querySelector('.tv-bbody')?.textContent).toContain('Cairo');
    expect(el.querySelectorAll('app-brief-comments .tv-cmt').length).toBe(2);
    f.destroy();
  });

  it('a comment whose passage the brief no longer has says so', async () => {
    const f = await render();
    const changed = Array.from((f.nativeElement as HTMLElement).querySelectorAll('.tv-cmt'))
      .filter((x) => x.querySelector('.tv-changed')).map((x) => x.querySelector('.tv-q')?.textContent?.trim());
    expect(changed).toEqual(['"a passage edited away" passage changed']);
    f.destroy();
  });

  it('selecting a passage offers 💬 Comment, which starts a comment quoting it', async () => {
    const f = await render();
    const el: HTMLElement = f.nativeElement;
    const li = Array.from(el.querySelectorAll('.tv-bbody li')).find((x) => x.textContent?.includes('Export uses')) as HTMLElement;
    const range = document.createRange();
    range.selectNodeContents(li);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
    el.querySelector('.tv-bbody')!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    f.detectChanges();
    (el.querySelector('.tv-selbtn') as HTMLButtonElement).click();
    f.detectChanges();
    expect(el.querySelector('.tv-draft .tv-q')?.textContent).toContain('"Export uses the filters"');
    f.destroy();
  });

  it('a brief-comments signal reloads only the comments', async () => {
    await render();
    expect(api.briefComments).toHaveBeenCalledTimes(1);
    events.next({ type: 'board-changed', cycleId: 'cy', what: 'brief-comments' });
    expect(api.briefComments).toHaveBeenCalledTimes(2);
    expect(api.brief).toHaveBeenCalledTimes(1);
    events.next({ type: 'board-changed', cycleId: 'cy', what: 'brief' });
    expect(api.brief).toHaveBeenCalledTimes(2);
  });
});
