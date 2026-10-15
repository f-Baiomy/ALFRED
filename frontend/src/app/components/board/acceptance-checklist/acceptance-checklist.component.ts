import { Component, DestroyRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter } from 'rxjs';
import {
  ChecklistFile, ChecklistItem, MARK_LABELS, Mark, Requirement, RequirementsView, VERDICTS, VERDICT_LABELS, Verdict,
} from '../../../core/models/board.models';
import { formatChecks, parseChecks } from '../../../shared/utils/evidence-syntax';
import { BoardApiService } from '../../../core/services/board-api.service';
import { BoardMentionsService } from '../../../core/services/board-mentions.service';
import { BoardSocketService } from '../../../core/services/board-socket.service';
import { messageOf } from '../../../core/state/board-state.service';
import { MarkdownViewComponent } from '../markdown-view/markdown-view.component';
import { MentionEditorComponent } from '../mention-editor/mention-editor.component';

/**
 * The acceptance items of the cycle's spec files as a checklist the user marks pass / fail / can't tell, with evidence
 * (FR-050) - and, beside each, its verdict by the calls (specs/018): Alfred judges every call to the item's endpoint in
 * code against the item's evidence, which Claude drafts and the user may rewrite here (one check per line).
 */
@Component({
  selector: 'app-acceptance-checklist',
  standalone: true,
  imports: [MarkdownViewComponent, MentionEditorComponent],
  template: `
    @if (files().length) {
      <div class="board-box">
        <h3>Acceptance checklist <small>marked by you · judged by the calls</small></h3>
        @if (counts().length) {
          <div class="board-verdict-counts" title="Each item's verdict by the calls, judged by Alfred in code as they arrive">
            @for (c of counts(); track c.verdict) {
              <span [class]="'board-verdict board-verdict-' + c.verdict">{{ c.count }} {{ verdictLabels[c.verdict].toLowerCase() }}</span>
            }
          </div>
        }
        @for (f of files(); track f.fileName) {
          <div class="board-dim board-check-file">from {{ f.fileName }}</div>
          <ul class="board-checklist">
            @for (item of f.items; track item.key) {
              <li>
                <span class="board-check-mark" [class]="'board-check-mark board-check-' + (item.mark?.mark ?? 'NONE')">{{ symbol(item) }}</span>
                <span class="board-check-text">{{ item.text }}</span>
                @if (requirement(f, item); as r) {
                  <span [class]="'board-verdict board-verdict-' + r.verdict.verdict" [title]="verdictTitle(r)">{{ verdictLabels[r.verdict.verdict] }}</span>
                }
                @if (item.mark?.evidence) { <span class="board-check-ev"><app-markdown-view [text]="item.mark!.evidence" /></span> }
                @if (editable()) {
                  <span class="board-check-acts">
                    @for (m of marks; track m) {
                      <button type="button" class="board-tog" [class.on]="item.mark?.mark === m" [title]="labels[m]" (click)="mark(f, item, m)">{{ labels[m] }}</button>
                    }
                    <button type="button" class="board-link" (click)="editing.set(editing() === item.key ? null : item.key)">evidence</button>
                    <button type="button" class="board-link" title="How the calls show this item" (click)="openChecks(f, item)">checks</button>
                  </span>
                }
                @if (requirement(f, item); as r) {
                  @if (r.verdict.reason || (r.verdict.verdict === 'NOT_EXERCISED' && r.evidence?.howTo)) {
                    <div class="board-dim board-verdict-why">{{ r.verdict.reason ?? 'How: ' + r.evidence!.howTo }}</div>
                  }
                }
                @if (checksOpen() === itemKey(f, item)) {
                  <div class="board-evidence-editor">
                    <label>Endpoint <input type="text" [value]="draftEndpoint()" (input)="draftEndpoint.set(value($event))"
                                           placeholder="POST /odeysysadmin/Booking2/refunded-requests/search - or UI" /></label>
                    <label>Checks <small>one per line: shape · when · match · rows · status</small>
                      <textarea rows="4" [value]="draftChecks()" (input)="draftChecks.set(value($event))"
                                placeholder="shape $.branch* list&#10;when $.branch* list>=2&#10;match $.payload branch* in $.branch*&#10;rows $.payload"></textarea></label>
                    <label>How to exercise it <input type="text" [value]="draftHowTo()" (input)="draftHowTo.set(value($event))" /></label>
                    @if (checksError()) { <div class="board-error">{{ checksError() }}</div> }
                    <span class="board-check-acts">
                      <button type="button" class="board-tog on" (click)="saveChecks(f, item)">Save</button>
                      @if (requirement(f, item)?.evidence) { <button type="button" class="board-link" (click)="deleteChecks(f, item)">delete</button> }
                      <button type="button" class="board-link" (click)="checksOpen.set(null)">cancel</button>
                    </span>
                  </div>
                }
                @if (editing() === item.key) {
                  <app-mention-editor [value]="item.mark?.evidence ?? ''" [project]="project()" [cycleId]="cycleId()" submitLabel="Save"
                                      [cancellable]="true" [allowEmpty]="true" [rows]="2" [draftKey]="'evidence:' + cycleId() + ':' + f.fileName + ':' + item.key"
                                      (submitted)="mark(f, item, item.mark?.mark ?? 'CANT_TELL', $event)" (cancelled)="editing.set(null)" />
                }
                @if (item.mark; as mk) { <span class="board-dim board-check-when">{{ when(mk.updatedAt) }}</span> }
                @if (item.cards?.length) {
                  <span class="board-check-cards" title="The cards about this item">
                    @for (c of item.cards; track c.number) {
                      <button type="button" class="board-link" [title]="c.title" (click)="openCard(c.project, c.number)">#{{ c.number }}</button>
                    }
                  </span>
                }
                @if (item.suggestion; as sg) {
                  <div class="board-check-suggest" [class]="'board-check-suggest board-check-' + sg.mark">
                    <span class="board-check-suggest-what">✦ Claude suggests {{ labels[sg.mark] }}</span>
                    @if (sg.evidence) { <app-markdown-view class="board-check-ev" [text]="sg.evidence" /> }
                    @if (editable()) {
                      <button type="button" class="board-tog on" title="Mark it as Claude suggests" (click)="acceptSuggestion(f, item)">Accept</button>
                      <button type="button" class="board-link" (click)="dismissSuggestion(f, item)">dismiss</button>
                    }
                  </div>
                }
              </li>
            }
          </ul>
        }
        @if (error()) { <div class="board-error">{{ error() }}</div> }
      </div>
    }`,
})
export class AcceptanceChecklistComponent {
  private readonly api = inject(BoardApiService);
  private readonly mentions = inject(BoardMentionsService);
  readonly cycleId = input.required<string>();
  readonly project = input('');
  readonly editable = input(true);

  readonly files = signal<readonly ChecklistFile[]>([]);
  readonly requirements = signal<RequirementsView | null>(null);
  readonly verdictLabels = VERDICT_LABELS;
  private readonly byItem = computed(() => new Map((this.requirements()?.items ?? []).map((r) => [`${r.fileName}\n${r.itemKey}`, r])));
  readonly counts = computed(() => {
    const c = this.requirements()?.counts ?? {};
    return VERDICTS.filter((v) => (c[v] ?? 0) > 0).map((v) => ({ verdict: v as Verdict, count: c[v]! }));
  });
  readonly checksOpen = signal<string | null>(null);
  readonly draftEndpoint = signal('');
  readonly draftChecks = signal('');
  readonly draftHowTo = signal('');
  readonly checksError = signal<string | null>(null);
  readonly editing = signal<string | null>(null);
  readonly error = signal<string | null>(null);
  readonly marks: readonly Mark[] = ['PASS', 'FAIL', 'CANT_TELL'];
  readonly labels = MARK_LABELS;

  constructor() {
    effect(() => {
      const id = this.cycleId();
      untracked(() => this.load(id));
    });
    inject(BoardSocketService).events$.pipe(
      filter((e) => e.type === 'board-changed' && e.cycleId === this.cycleId()
        && (e.what === 'checklist' || e.what === 'specs' || e.what === 'requirements')),
      takeUntilDestroyed(inject(DestroyRef)),
    ).subscribe(() => this.load(this.cycleId()));
  }

  private load(id: string): void {
    this.api.checklist(id).subscribe({ next: (f) => this.files.set(f), error: (e) => this.error.set(messageOf(e)) });
    // an Alfred without the requirement check answers 404: the checklist is shown as before
    this.api.requirements(id).subscribe({ next: (r) => this.requirements.set(r), error: () => this.requirements.set(null) });
  }

  itemKey(file: ChecklistFile, item: ChecklistItem): string {
    return `${file.fileName}/${item.key}`;
  }

  requirement(file: ChecklistFile, item: ChecklistItem): Requirement | null {
    return this.byItem().get(`${file.fileName}\n${item.key}`) ?? null;
  }

  verdictTitle(r: Requirement): string {
    const c = r.verdict.counts;
    const calls = c.contradicts + c.wrong + c.meets + c.noData + c.unknown;
    return `By the calls: ${VERDICT_LABELS[r.verdict.verdict]}${calls ? ` - ${calls} call${calls === 1 ? '' : 's'} judged` : ''}`
      + `${r.evidence ? ` · ${r.evidence.endpoint}` : ''}${r.cardNumber ? ` · card #${r.cardNumber}` : ''}`;
  }

  openChecks(file: ChecklistFile, item: ChecklistItem): void {
    const key = this.itemKey(file, item);
    if (this.checksOpen() === key) { this.checksOpen.set(null); return; }
    const ev = this.requirement(file, item)?.evidence;
    this.draftEndpoint.set(ev?.endpoint ?? '');
    this.draftChecks.set(formatChecks(ev?.checks ?? []));
    this.draftHowTo.set(ev?.howTo ?? '');
    this.checksError.set(null);
    this.checksOpen.set(key);
  }

  saveChecks(file: ChecklistFile, item: ChecklistItem): void {
    const { checks, error } = parseChecks(this.draftChecks());
    if (error) { this.checksError.set(error); return; }
    this.api.putEvidence(this.cycleId(), { fileName: file.fileName, itemKey: item.key, project: this.project(),
      endpoint: this.draftEndpoint().trim(), checks, howTo: this.draftHowTo().trim() }).subscribe({
      next: () => { this.checksOpen.set(null); this.load(this.cycleId()); },
      error: (e) => this.checksError.set(messageOf(e)),
    });
  }

  deleteChecks(file: ChecklistFile, item: ChecklistItem): void {
    this.api.deleteEvidence(this.cycleId(), file.fileName, item.key).subscribe({
      next: () => { this.checksOpen.set(null); this.load(this.cycleId()); },
      error: (e) => this.checksError.set(messageOf(e)),
    });
  }

  value(event: Event): string {
    return (event.target as HTMLInputElement | HTMLTextAreaElement).value;
  }

  symbol(item: ChecklistItem): string {
    switch (item.mark?.mark) {
      case 'PASS': return '✓';
      case 'FAIL': return '✗';
      case 'CANT_TELL': return '?';
      default: return '·';
    }
  }

  mark(file: ChecklistFile, item: ChecklistItem, mark: Mark, evidence?: string): void {
    this.editing.set(null);
    this.api.mark(this.cycleId(), file.fileName, item.key, mark, evidence ?? item.mark?.evidence ?? '').subscribe({
      next: () => this.load(this.cycleId()),
      error: (e) => this.error.set(messageOf(e)),
    });
  }

  /** The user's mark, with Claude's evidence. */
  acceptSuggestion(file: ChecklistFile, item: ChecklistItem): void {
    this.api.acceptSuggestion(this.cycleId(), file.fileName, item.key).subscribe({
      next: () => this.load(this.cycleId()),
      error: (e) => this.error.set(messageOf(e)),
    });
  }

  dismissSuggestion(file: ChecklistFile, item: ChecklistItem): void {
    this.api.dismissSuggestion(this.cycleId(), file.fileName, item.key).subscribe({
      next: () => this.load(this.cycleId()),
      error: (e) => this.error.set(messageOf(e)),
    });
  }

  openCard(project: string, number: number): void {
    this.mentions.cardToOpen.set({ project, number });
  }

  when(iso: string): string {
    return new Date(iso).toLocaleString();
  }
}
