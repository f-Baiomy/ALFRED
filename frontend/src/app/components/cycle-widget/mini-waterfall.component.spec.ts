import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MiniWaterfallComponent, MiniWaterfallRow, SpacerRequest } from './mini-waterfall.component';
import { CycleSpacer } from '../../core/state/call-selection.tokens';
import { CallRecord } from '../../core/models/call.model';
import { buildCallTree, indexCallTree } from '../../shared/utils/call-tree';

const T0 = Date.parse('2026-09-27T10:00:00.000Z');

function call(id: string, startMs: number, durationMs: number, internal = true): CallRecord {
  return {
    id,
    original_url: `https://host/${id}`,
    url: `https://host/${id}`,
    method: 'POST',
    timestamp: new Date(T0 + startMs).toISOString(),
    duration_ms: durationMs,
    response: { status: 200 } as CallRecord['response'],
    service_name: internal ? `svc-${id}` : null,
    source: internal ? 'internal' : 'external',
  };
}

/** A chain five levels deep - l0 contains l1 contains ... l4 - plus a second root. */
const CHAIN = [
  call('l0', 0, 1000),
  call('l1', 50, 800),
  call('l2', 100, 600),
  call('l3', 150, 400),
  call('l4', 200, 100, false),
  call('other', 2000, 100, false),
];

function render(calls: readonly CallRecord[]): ComponentFixture<MiniWaterfallComponent> {
  const fixture = TestBed.createComponent(MiniWaterfallComponent);
  fixture.componentRef.setInput('nodes', buildCallTree(calls));
  fixture.componentRef.setInput('depths', indexCallTree(calls));
  fixture.detectChanges();
  return fixture;
}

function rows(fixture: ComponentFixture<MiniWaterfallComponent>): MiniWaterfallRow[] {
  return fixture.componentInstance.entries().flatMap((e) => (e.kind === 'row' ? [e.row] : []));
}

function rowIds(fixture: ComponentFixture<MiniWaterfallComponent>): string[] {
  return rows(fixture).map((r) => r.call.id);
}

/** Calls and spacers in display order, gaps left out - 'S:<label>' for a spacer. */
function layout(fixture: ComponentFixture<MiniWaterfallComponent>): string[] {
  return fixture.componentInstance.entries().flatMap((e) => (e.kind === 'row' ? [e.row.call.id] : e.kind === 'spacer' ? [`S:${e.spacer.label}`] : []));
}

describe('MiniWaterfallComponent', () => {
  it('renders every level of a deep chain, each nested one deeper', () => {
    const fixture = render(CHAIN);
    expect(rows(fixture).map((r) => [r.call.id, r.depth])).toEqual([
      ['l0', 0],
      ['l1', 1],
      ['l2', 2],
      ['l3', 3],
      ['l4', 4],
      ['other', 0],
    ]);
    expect(fixture.nativeElement.querySelectorAll('.cw-wf-row').length).toBe(6);
    expect(fixture.nativeElement.textContent).toContain('5 levels');
  });

  it('badges a parent with how many calls sit anywhere underneath it', () => {
    const fixture = render(CHAIN);
    const counts = [...fixture.nativeElement.querySelectorAll('.cw-wf-count')].map((el: Element) => el.textContent!.trim());
    expect(counts).toEqual(['4', '3', '2', '1']);
  });

  it('folds a parent to hide its whole subtree, and shows the hidden count with a plus', () => {
    const fixture = render(CHAIN);
    fixture.componentInstance.toggleFold('l1');
    fixture.detectChanges();
    expect(rowIds(fixture)).toEqual(['l0', 'l1', 'other']);
    const l1Count = fixture.nativeElement.querySelectorAll('.cw-wf-count')[1];
    expect(l1Count.textContent.trim()).toBe('+3');
  });

  it('collapse all folds the roots, expand all opens everything', () => {
    const fixture = render(CHAIN);
    fixture.componentInstance.collapseAll();
    expect(rowIds(fixture)).toEqual(['l0', 'other']);
    fixture.componentInstance.expandAll();
    expect(rowIds(fixture).length).toBe(6);
  });

  it('unfolds the path to a call that just arrived under a folded parent', () => {
    const fixture = render(CHAIN);
    fixture.componentInstance.collapseAll();
    fixture.componentRef.setInput('flashId', 'l4');
    fixture.detectChanges();
    expect(rowIds(fixture)).toContain('l4');
  });

  it('labels inbound calls with their project and outbound calls with their host', () => {
    const fixture = render(CHAIN);
    const r = rows(fixture);
    expect(r[0].direction).toBe('inbound');
    expect(r[0].service).toBe('svc-l0');
    expect(r[0].path).toBe('/l0');
    expect(r[4].direction).toBe('outbound');
    expect(r[4].path).toBe('host/l4');
  });

  describe('spacers', () => {
    const afterChain: CycleSpacer = { id: 's1', label: 'Chain done', afterCallId: 'l0', anchorTimestamp: CHAIN[0].timestamp };
    const onNested: CycleSpacer = { id: 's2', label: 'Nested anchor', afterCallId: 'l3', anchorTimestamp: CHAIN[3].timestamp };

    function withSpacers(spacers: CycleSpacer[], descending = false): ComponentFixture<MiniWaterfallComponent> {
      const calls = descending ? [...CHAIN].reverse() : CHAIN;
      const fixture = TestBed.createComponent(MiniWaterfallComponent);
      fixture.componentRef.setInput('nodes', buildCallTree(calls));
      fixture.componentRef.setInput('depths', indexCallTree(calls));
      fixture.componentRef.setInput('spacers', spacers);
      fixture.componentRef.setInput('descending', descending);
      fixture.detectChanges();
      return fixture;
    }

    it('places a spacer after its call\'s whole root group - and one anchored to a nested call there too', () => {
      const fixture = withSpacers([afterChain, onNested]);
      expect(layout(fixture)).toEqual(['l0', 'l1', 'l2', 'l3', 'l4', 'S:Chain done', 'S:Nested anchor', 'other']);
      expect(fixture.nativeElement.querySelectorAll('.cw-wf-spacer').length).toBe(2);
    });

    it('newest first, "after" a call is above it', () => {
      const fixture = withSpacers([afterChain], true);
      expect(layout(fixture)).toEqual(['other', 'S:Chain done', 'l0', 'l1', 'l2', 'l3', 'l4']);
    });

    it('adds a spacer at a gap with that gap\'s anchor', () => {
      const fixture = withSpacers([]);
      const added: SpacerRequest[] = [];
      fixture.componentInstance.addSpacer.subscribe((r) => added.push(r));
      const gap = fixture.componentInstance.entries().find((e) => e.kind === 'gap' && e.key === 'gap-other');
      fixture.componentInstance.startAdding('gap-other', gap!.kind === 'gap' ? gap!.anchor : undefined);
      fixture.componentInstance.finishAdding('  Second step ');
      expect(added).toEqual([{ label: 'Second step', anchor: { afterCallId: 'l0', anchorTimestamp: CHAIN[0].timestamp } }]);
    });

    it('the header\'s "+ Spacer" goes after the latest call', () => {
      const fixture = withSpacers([]);
      const latest = { afterCallId: 'other', anchorTimestamp: CHAIN[5].timestamp };
      fixture.componentRef.setInput('latestAnchor', latest);
      const added: SpacerRequest[] = [];
      fixture.componentInstance.addSpacer.subscribe((r) => added.push(r));
      fixture.componentInstance.startAdding('latest');
      fixture.componentInstance.finishAdding('Now');
      expect(added[0].anchor).toEqual(latest);
    });

    it('renames inline and only emits a real change', () => {
      const fixture = withSpacers([afterChain]);
      const renamed: string[] = [];
      fixture.componentInstance.renameSpacer.subscribe((r) => renamed.push(r.label));
      fixture.componentInstance.startRename('s1');
      fixture.componentInstance.finishRename(afterChain, 'Chain done');
      fixture.componentInstance.startRename('s1');
      fixture.componentInstance.finishRename(afterChain, 'Checkout');
      expect(renamed).toEqual(['Checkout']);
    });
  });

  it('selecting a row opens its detail with "Show in cycle"', () => {
    const fixture = render(CHAIN);
    const shown: string[] = [];
    fixture.componentInstance.showInCycle.subscribe((c) => shown.push(c.id));
    (fixture.nativeElement.querySelector('[data-call-id="l2"]') as HTMLElement).click();
    fixture.detectChanges();
    const detail = fixture.nativeElement.querySelector('.cw-wf-detail') as HTMLElement;
    expect(detail.textContent).toContain('https://host/l2');
    expect(detail.textContent).toContain('inside POST l1');
    (detail.querySelector('.cw-wf-show') as HTMLButtonElement).click();
    expect(shown).toEqual(['l2']);
  });

  it('still explains an empty waterfall when the cycle only has spacers', () => {
    const fixture = TestBed.createComponent(MiniWaterfallComponent);
    fixture.componentRef.setInput('nodes', []);
    fixture.componentRef.setInput('depths', new Map());
    fixture.componentRef.setInput('spacers', [{ id: 's', label: 'asdd', afterCallId: 'gone', anchorTimestamp: null }]);
    fixture.componentRef.setInput('emptyText', 'All calls are hidden: 11 OPTIONS preflights.');
    fixture.componentRef.setInput('emptyAction', 'Show OPTIONS');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.cw-wf-spacer')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.cw-wf-empty').textContent).toContain('11 OPTIONS preflights');
    expect(fixture.nativeElement.querySelector('.cw-wf-empty button').textContent).toContain('Show OPTIONS');
  });

  it('shows the empty text when there are no calls', () => {
    const fixture = render([]);
    fixture.componentRef.setInput('emptyText', 'Recording. Calls appear here as they arrive.');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.cw-wf-empty').textContent).toContain('Recording.');
  });
});
