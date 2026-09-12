import { ComponentFixture, TestBed } from '@angular/core/testing';
import { JsonFlatViewComponent, LineTokens, WINDOWING_LINE_THRESHOLD } from './json-flat-view.component';
import { Comment } from '../../core/models/comment.model';

function lines(count: number): LineTokens[] {
  return Array.from({ length: count }, (_, index) => ({
    index,
    tokens: [{ text: `line ${index}`, cls: '' as const, highlighted: false }],
  }));
}

function comment(id: string, lineIndex: number): Comment {
  return {
    id,
    callId: 'call-1',
    block: 'response-body',
    lineIndex,
    lineText: `line ${lineIndex}`,
    comment: 'looks wrong',
    createdAt: '2026-01-01T00:00:00.000Z',
  } as Comment;
}

describe('JsonFlatViewComponent', () => {
  let fixture: ComponentFixture<JsonFlatViewComponent>;
  let component: JsonFlatViewComponent;

  async function render(lineCount: number, commentsByLine = new Map<number, Comment[]>()): Promise<void> {
    fixture = TestBed.createComponent(JsonFlatViewComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('lines', lines(lineCount));
    fixture.componentRef.setInput('commentsByLine', commentsByLine);
    fixture.detectChanges();
    await fixture.whenStable();
  }

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [JsonFlatViewComponent] }).compileComponents();
  });

  function renderedRowCount(): number {
    return fixture.nativeElement.querySelectorAll('.code-line').length;
  }

  it('renders every line, unwindowed, below the threshold', async () => {
    await render(50);

    expect(component.windowed()).toBe(false);
    expect(renderedRowCount()).toBe(50);
    expect(fixture.nativeElement.querySelectorAll('.code-spacer').length).toBe(0);
  });

  it('renders only a window of rows above the threshold', async () => {
    await render(WINDOWING_LINE_THRESHOLD + 1);

    expect(component.windowed()).toBe(true);
    // The exact count depends on the measured viewport, but the entire point is that it is a tiny
    // fraction of the input - a 640KB body measured 28,937 rows and 186,734 nodes before this.
    expect(renderedRowCount()).toBeLessThan(200);
    expect(renderedRowCount()).toBeGreaterThan(0);
  });

  it('reserves the full scroll height in spacers so the scrollbar still reflects the whole body', async () => {
    const count = WINDOWING_LINE_THRESHOLD + 1000;
    await render(count);

    const rendered = renderedRowCount();
    // 19px per line, mirrored from the pinned CSS height.
    expect(component.spacerTopPx() + component.spacerBottomPx() + rendered * 19).toBe(count * 19);
  });

  it('reserves extra height for the comment cards of a line outside the window', async () => {
    // Deliberately a line far below the window: its cards are never rendered, so the space they
    // will need has to come out of the bottom spacer or the scrollbar would lie about the length.
    const byLine = new Map<number, Comment[]>([[1500, [comment('c1', 1500), comment('c2', 1500)]]]);
    const count = WINDOWING_LINE_THRESHOLD + 1;
    await render(count, byLine);

    const accounted = component.spacerTopPx() + component.spacerBottomPx() + renderedRowCount() * 19;
    expect(accounted).toBe(count * 19 + 2 * 44);
  });

  it('keeps comments inline and rendered when their line is in the window', async () => {
    const byLine = new Map<number, Comment[]>([[0, [comment('c1', 0)]]]);
    await render(WINDOWING_LINE_THRESHOLD + 1, byLine);

    expect(fixture.nativeElement.querySelectorAll('.comment-card').length).toBe(1);
  });

  it('reserves the composer height it measures, not a hardcoded guess', async () => {
    const count = WINDOWING_LINE_THRESHOLD + 1000;
    await render(count);
    expect(component.contentHeightPx()).toBe(count * 19);

    fixture.nativeElement.querySelectorAll('.code-line')[0].querySelector('.line-comment-btn').click();
    fixture.detectChanges();
    // The measurement arrives via ResizeObserver, which fires outside Angular's own scheduling.
    await new Promise((resolve) => setTimeout(resolve, 50));
    fixture.detectChanges();

    const measured = fixture.nativeElement.querySelector('.comment-composer').offsetHeight;
    expect(measured).toBeGreaterThan(0);
    // Pinning this to 92px, as an earlier version did, squashed a control needing 102px and let it
    // spill over the code lines around it - so the table must follow the element, not the reverse.
    expect(component.contentHeightPx()).toBe(count * 19 + measured);
  });

  it('scrollToRow reports false when not windowing, so the caller can fall back to the DOM', async () => {
    await render(50);

    expect(component.scrollToRow(10)).toBe(false);
  });

  it('scrollToRow moves the window to a row that was never rendered', async () => {
    await render(WINDOWING_LINE_THRESHOLD + 1000);

    const before = fixture.nativeElement.querySelectorAll('.code-line');
    const beforeLast = Number(before[before.length - 1].querySelector('.line-number').textContent);

    expect(component.scrollToRow(2500)).toBe(true);
    fixture.detectChanges();

    const after = fixture.nativeElement.querySelectorAll('.code-line');
    const firstAfter = Number(after[0].querySelector('.line-number').textContent);
    expect(beforeLast).toBeLessThan(2000);
    expect(firstAfter).toBeGreaterThan(2000);
  });

  it('emits the original line index when commenting on a windowed row', async () => {
    await render(WINDOWING_LINE_THRESHOLD + 1000);
    component.scrollToRow(2500);
    fixture.detectChanges();

    const emitted: number[] = [];
    component.addComment.subscribe((e) => emitted.push(e.lineIndex));

    const row = fixture.nativeElement.querySelectorAll('.code-line')[0];
    const shownLineNumber = Number(row.querySelector('.line-number').textContent);
    row.querySelector('.line-comment-btn').click();
    fixture.detectChanges();

    fixture.nativeElement.querySelector('.comment-composer textarea').value = 'note';
    fixture.nativeElement.querySelector('.comment-composer textarea').dispatchEvent(new Event('input'));
    fixture.detectChanges();
    fixture.nativeElement.querySelector('.comment-composer .primary').click();

    expect(emitted).toEqual([shownLineNumber - 1]);
  });
});
