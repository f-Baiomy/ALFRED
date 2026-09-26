import { Component, computed, inject, input, signal } from '@angular/core';
import { HighlightToken, markVariableTokens } from '../../utils/json-tokenizer';
import { GlobalVariablesService } from '../../../core/services/global-variables.service';

/**
 * Renders a list of already-highlighted tokens as text - never innerHTML.
 * Shared by the flat view, the tree view, and plain-text bodies, so the
 * "how do we show a <mark>" decision lives in exactly one place.
 */
@Component({
  selector: 'app-json-tokens',
  standalone: true,
  templateUrl: './json-tokens.component.html',
  styles: [`
    .variable-hover-wrap{position:relative;cursor:help}.variable-hover-card{position:absolute;left:0;bottom:calc(100% + 8px);z-index:120;width:250px;padding:10px;border:1px solid #655484;border-radius:8px;background:#211f29;color:#eee;box-shadow:0 8px 24px #0008;font:12px/1.4 system-ui;white-space:normal}.variable-hover-card label{display:block;margin-bottom:6px}.variable-hover-card code{color:#e2cdff}.variable-hover-card textarea{display:block;width:100%;min-height:55px;box-sizing:border-box;resize:vertical;background:#121219;color:#eee;border:1px solid #494453;border-radius:5px;padding:7px;font:12px/1.4 ui-monospace,monospace}.variable-hover-card small{display:block;color:#aaa6b7;margin-top:5px}
  `],
})
export class JsonTokensComponent {
  readonly tokens = input.required<readonly HighlightToken[]>();
  readonly renderTokens = computed(() => markVariableTokens(this.tokens()));
  readonly activeMatchIndex = input<number>(-1);
  readonly variables = inject(GlobalVariablesService, { optional: true });
  readonly hoveredVariable = signal('');
  private hoverTimer?: ReturnType<typeof setTimeout>;

  hoverToken(text: string): void {
    clearTimeout(this.hoverTimer);
    const name = text.slice(2, -2);
    this.hoverTimer = setTimeout(() => this.hoveredVariable.set(name), 450);
  }

  leaveToken(): void {
    clearTimeout(this.hoverTimer);
    this.hoverTimer = setTimeout(() => this.hoveredVariable.set(''), 220);
  }

  valueOf(name: string): string { return this.variables?.state().variables[name] ?? ''; }
  saveValue(name: string, event: Event): void { this.variables?.upsert(name, (event.target as HTMLTextAreaElement).value); }
}
