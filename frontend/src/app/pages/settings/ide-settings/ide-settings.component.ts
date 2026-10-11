import { Component, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { catchError, map, of } from 'rxjs';
import { DbCaptureApiService } from '../../../core/services/db-capture-api.service';
import { IdeFoldersService } from '../../../core/services/ide-folders.service';

/**
 * Settings → Open in IDE: each project's source folders on THIS computer, for the "VS Code ↗" links in "Where in
 * code". Saved in this browser only - the Alfred server may be another machine, and every computer has its own paths.
 * IntelliJ needs nothing here: it opens through its own local server and finds the file in the open project.
 */
@Component({
  selector: 'app-ide-settings',
  standalone: true,
  template: `
    <section class="panel settings-panel ide-settings">
      <h3>Open in IDE <span class="sub">this browser only</span></h3>
      <p class="sub">
        "Where in code" opens a code line in the IDE on the computer you are using now - not on the Alfred server.
        <b>IntelliJ</b> needs no folders: it opens files through its local server (port 63342) and finds the package path in
        the open project's source folders. That server needs IntelliJ's free <b>IDE Remote Control</b> plugin (Settings →
        Plugins → Marketplace). <b>VS Code</b> needs the folder that holds each project's sources on this computer - where
        <code>com/…</code> starts, e.g. <code>C:\\projects\\odeysys\\src\\main\\java</code>. One per line for a build with several
        modules.
      </p>
      <table class="teams-table ide-table">
        <thead><tr><th>Project</th><th>Source folders on this computer</th><th></th></tr></thead>
        <tbody>
          @for (p of projects(); track p) {
            <tr>
              <td>{{ p }}</td>
              <td><textarea class="teams-input" rows="2" [value]="text(p)" placeholder="C:\\projects\\{{ p }}\\src\\main\\java"
                            [attr.aria-label]="'Source folders of ' + p" (input)="draft(p, $any($event.target).value)"></textarea></td>
              <td class="teams-acts">
                <button type="button" class="bulk-btn" [disabled]="!dirty(p)" (click)="save(p)">{{ saved() === p ? '✓ Saved' : 'Save' }}</button>
              </td>
            </tr>
          } @empty {
            <tr><td colspan="3" class="board-dim">No projects yet - they appear once Alfred has captured a project's database calls.</td></tr>
          }
        </tbody>
      </table>
    </section>`,
})
export class IdeSettingsComponent {
  private readonly ide = inject(IdeFoldersService);
  readonly projects = toSignal(inject(DbCaptureApiService).projects().pipe(map((ps) => ps.map((p) => p.project).filter(Boolean)),
    catchError(() => of([] as string[]))), { initialValue: [] as string[] });
  private readonly drafts = signal<Readonly<Record<string, string>>>({});
  readonly saved = signal<string | null>(null);

  text(project: string): string {
    return this.drafts()[project] ?? this.ide.of(project).join('\n');
  }

  draft(project: string, value: string): void {
    this.drafts.update((d) => ({ ...d, [project]: value }));
    this.saved.set(null);
  }

  dirty(project: string): boolean {
    const d = this.drafts()[project];
    return d !== undefined && d !== this.ide.of(project).join('\n');
  }

  save(project: string): void {
    this.ide.set(project, (this.drafts()[project] ?? '').split('\n'));
    this.drafts.update((d) => {
      const next = { ...d };
      delete next[project];
      return next;
    });
    this.saved.set(project);
  }
}
