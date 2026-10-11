import { Component, inject, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { Team, TeamEdit } from '../../../core/models/board.models';
import { ConfirmDialogService } from '../../../core/services/confirm-dialog.service';
import { messageOf } from '../../../core/state/board-state.service';
import { TeamsStateService } from '../../../core/state/teams-state.service';

interface Draft {
  id: string | null;
  name: string;
  color: string;
  icon: string;
  owns: string;
  hints: string;
}

/**
 * Settings → Teams: the teams board cards are assigned to. Alfred starts with six (Frontend, Backend, Database,
 * Integrations, DevOps, QA); every one can be renamed, changed, reordered or deleted. "Owns" is what Claude reads to
 * pick a card's teams, so it should name the evidence that points at the team; hints (one per line) pre-fill the teams
 * of a card created without any when its title or description contains one.
 */
@Component({
  selector: 'app-teams-settings',
  standalone: true,
  imports: [NgTemplateOutlet],
  template: `
    <section class="panel settings-panel teams-settings">
      <h3>Teams <span class="sub">who board cards are assigned to</span></h3>
      <p class="sub">A card can have several teams. Claude reads "Owns" to choose them; hints pre-fill the teams of a card created without any.</p>
      <table class="teams-table">
        <thead><tr><th></th><th>Team</th><th>Owns</th><th>Hints</th><th></th></tr></thead>
        <tbody>
          @for (t of teams.teams(); track t.id; let i = $index; let last = $last) {
            @if (draft()?.id === t.id) {
              <ng-container *ngTemplateOutlet="editor" />
            } @else {
              <tr>
                <td class="teams-order">
                  <button type="button" class="board-link" [disabled]="i === 0" title="Move up" (click)="move(i, -1)">▲</button>
                  <button type="button" class="board-link" [disabled]="last" title="Move down" (click)="move(i, 1)">▼</button>
                </td>
                <td><span class="board-team" [style.--team]="t.color">@if (t.icon) { <span aria-hidden="true">{{ t.icon }}</span> }{{ t.name }}</span>
                  <div class="board-dim teams-id">{{ t.id }}</div></td>
                <td class="teams-owns">{{ t.owns || '—' }}</td>
                <td class="teams-hints">@for (h of t.hints; track h) { <code>{{ h }}</code> } @empty { <span class="board-dim">—</span> }</td>
                <td class="teams-acts">
                  <button type="button" class="board-link" (click)="edit(t)">Edit</button>
                  <button type="button" class="board-link danger" (click)="remove(t)">Delete</button>
                </td>
              </tr>
            }
          }
          @if (draft() && draft()!.id === null) { <ng-container *ngTemplateOutlet="editor" /> }
        </tbody>
      </table>
      @if (!draft()) { <button type="button" class="bulk-btn" (click)="add()">+ Add team</button> }
      @if (error()) { <div class="board-error" role="alert">{{ error() }}</div> }
    </section>

    <ng-template #editor>
      @if (draft(); as d) {
        <tr class="teams-editor">
          <td></td>
          <td>
            <input class="teams-input" type="text" maxlength="60" placeholder="Name" [value]="d.name" (input)="patch({ name: $any($event.target).value })" />
            <div class="teams-row">
              <input class="teams-icon" type="text" maxlength="4" placeholder="Icon" title="Icon (an emoji or a symbol)" [value]="d.icon"
                     (input)="patch({ icon: $any($event.target).value })" />
              <input class="teams-color" type="color" title="Colour" [value]="d.color" (input)="patch({ color: $any($event.target).value })" />
            </div>
          </td>
          <td><textarea class="teams-input" rows="3" maxlength="2000" placeholder="What this team owns - Claude reads it to pick teams"
                        [value]="d.owns" (input)="patch({ owns: $any($event.target).value })"></textarea></td>
          <td><textarea class="teams-input" rows="3" placeholder="One hint per line: .java:  /Booking2/  com.x.supplier  galileo"
                        [value]="d.hints" (input)="patch({ hints: $any($event.target).value })"></textarea></td>
          <td class="teams-acts">
            <button type="button" class="bulk-btn" [disabled]="!d.name.trim() || busy()" (click)="save()">Save</button>
            <button type="button" class="board-link" (click)="draft.set(null)">Cancel</button>
          </td>
        </tr>
      }
    </ng-template>`,
})
export class TeamsSettingsComponent {
  readonly teams = inject(TeamsStateService);
  private readonly confirm = inject(ConfirmDialogService);
  readonly draft = signal<Draft | null>(null);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);

  constructor() {
    this.teams.load(true);
  }

  add(): void {
    this.draft.set({ id: null, name: '', color: '#8b8b93', icon: '', owns: '', hints: '' });
  }

  edit(t: Team): void {
    this.draft.set({ id: t.id, name: t.name, color: t.color, icon: t.icon, owns: t.owns, hints: t.hints.join('\n') });
  }

  patch(change: Partial<Draft>): void {
    const d = this.draft();
    if (d) this.draft.set({ ...d, ...change });
  }

  save(): void {
    const d = this.draft();
    if (!d) return;
    const edit: TeamEdit = { name: d.name.trim(), color: d.color, icon: d.icon.trim(), owns: d.owns.trim(),
      hints: d.hints.split('\n').map((h) => h.trim()).filter(Boolean) };
    this.busy.set(true);
    this.teams.save(d.id, edit).subscribe({
      next: () => {
        this.busy.set(false);
        this.error.set(null);
        this.draft.set(null);
      },
      error: (e) => {
        this.busy.set(false);
        this.error.set(messageOf(e));
      },
    });
  }

  remove(t: Team): void {
    void this.confirm.confirm(`Delete the team “${t.name}”? It is taken off every card it is on.`, 'Delete').then((ok) => {
      if (!ok) return;
      this.teams.delete(t.id).subscribe({ next: () => this.error.set(null), error: (e) => this.error.set(messageOf(e)) });
    });
  }

  move(index: number, by: number): void {
    const ids = this.teams.teams().map((t) => t.id);
    const to = index + by;
    if (to < 0 || to >= ids.length) return;
    [ids[index], ids[to]] = [ids[to], ids[index]];
    this.teams.reorder(ids).subscribe({ error: (e) => this.error.set(messageOf(e)) });
  }
}
