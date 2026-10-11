import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { IdeFoldersService } from '../../core/services/ide-folders.service';
import { copyToClipboard } from '../../shared/utils/clipboard';
import { INTELLIJ_API, intellijUrl, parseCodeFrame, vscodeUrl } from '../../shared/utils/code-frame';
import { SelectOption, SelectPickerComponent } from '../select-picker/select-picker.component';

/**
 * "Open this line" for one stack frame, on the computer the browser runs on (the Alfred server may be another
 * machine): IntelliJ through its local server (its "IDE Remote Control" plugin; it finds the package path in the open
 * project's source folders by itself), VS Code by
 * full path from Settings → Open in IDE (this browser's folders for the project; a menu when there are several), and a
 * copy of `File.java:line` for the IDE's own "go to file".
 */
@Component({
  standalone: true,
  selector: 'app-code-link',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, SelectPickerComponent],
  template: `
    @if (frame(); as f) {
      <span class="code-link">
        <button type="button" class="code-link-btn ij" [title]="'Open ' + (f.path ?? f.file) + ':' + f.line + ' in IntelliJ on this computer'"
                (click)="openIntellij()">IntelliJ ↗</button>
        @if (!f.path) {
          <span class="code-link-note" title="Captured before the agent recorded packages - VS Code needs the full path; IntelliJ and Copy still work">VS Code: no package</span>
        } @else if (vscodeOptions().length === 1) {
          <a class="code-link-btn vs" [href]="vscodeOptions()[0].value" [title]="'Open in VS Code: ' + vscodeOptions()[0].label">VS Code ↗</a>
        } @else if (vscodeOptions().length > 1) {
          <app-select-picker class="select-compact code-link-pick" [options]="vscodeOptions()" value="" placeholder="VS Code ↗"
                             ariaLabel="Open in VS Code from which folder" (valueChange)="go($event)" />
        } @else {
          <a class="code-link-btn vs off" routerLink="/settings" [queryParams]="{ section: 'ide' }"
             title="VS Code needs this project's source folder on this computer">VS Code: set folder</a>
        }
        <button type="button" class="code-link-btn" [title]="'Copy ' + f.file + ':' + f.line + ' - paste it in IntelliJ\\'s Ctrl+Shift+N or VS Code\\'s Ctrl+P'"
                (click)="copy()">{{ copied() ? '✓ copied' : '⧉ ' + f.file + ':' + f.line }}</button>
        @if (message(); as m) { <span class="code-link-note">{{ m }}</span> }
      </span>
    }`,
})
export class CodeLinkComponent {
  private readonly ideFolders = inject(IdeFoldersService);
  readonly text = input<string | null | undefined>(null);
  readonly project = input<string | null | undefined>(null);

  readonly frame = computed(() => parseCodeFrame(this.text()));
  readonly copied = signal(false);
  readonly message = signal<string | null>(null);

  readonly vscodeOptions = computed<SelectOption[]>(() => {
    const f = this.frame();
    if (!f) return [];
    return this.ideFolders.of(this.project())
      .map((folder) => ({ value: vscodeUrl(folder, f) ?? '', label: folder }))
      .filter((o) => !!o.value);
  });

  /**
   * Asks IntelliJ in the background - no tab opens. What can be told apart: not running, its open-file plugin missing
   * (404 on the bare API; with the plugin it is 400), refused. A file it cannot find is NOT told: IntelliJ answers 200
   * then too, on purpose (it only logs "File … not found") - so a frame without a package, which IntelliJ cannot find by
   * name alone, is not sent at all, and a sent one says "sent", never "opened".
   */
  async openIntellij(): Promise<void> {
    const f = this.frame();
    if (!f) return;
    if (!f.path) {
      this.message.set(`IntelliJ cannot open a file by its name alone (captured before the package was recorded) - ⧉ copy it and use Ctrl+Shift+N`);
      return;
    }
    this.message.set('asking IntelliJ…');
    const probe = await fetch(INTELLIJ_API).catch(() => null);
    if (!probe) {
      this.message.set('IntelliJ is not running on this computer');
      return;
    }
    if (probe.status === 404) {
      this.message.set('IntelliJ needs the "IDE Remote Control" plugin - Settings → Plugins → Marketplace, then restart IntelliJ');
      return;
    }
    const r = await fetch(intellijUrl(f)).catch(() => null);
    if (r?.status === 403) {
      this.message.set(`IntelliJ refused - allow ${window.location.origin} in its prompt and try again`);
    } else if (r?.ok) {
      this.message.set(`sent to IntelliJ - nothing opened? the open project does not have ${f.path}`);
    } else {
      this.message.set(`IntelliJ answered ${r?.status ?? 'nothing'} - ⧉ copy the file and use Ctrl+Shift+N`);
    }
  }

  go(url: string): void {
    if (url) window.location.href = url;
  }

  copy(): void {
    const f = this.frame();
    if (!f) return;
    void copyToClipboard(`${f.file}:${f.line}`).then(() => {
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 1500);
    });
  }
}
