import { Component, computed, inject, input, signal } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { MentionRef } from '../../../core/models/board.models';
import { ChatConsent, ChatMessage } from '../../../core/models/chat.models';
import { CallsApiService } from '../../../core/services/calls-api.service';
import { ChatApiService } from '../../../core/services/chat-api.service';
import { ConsentService } from '../../../core/services/consent.service';
import { ResendDialogService } from '../../../core/services/resend-dialog.service';
import { RuleDraftService } from '../../../core/services/rule-draft.service';
import { ChatStateService } from '../../../core/state/chat-state.service';
import { messageOf } from '../../../core/state/board-state.service';
import { callOf } from '../../../shared/utils/mention-syntax';

/**
 * A resend or an interception rule Claude prepared in the chat (specs/022 FR-028). Nothing runs from the chat itself:
 * "Review" shows the board's consent dialog with exactly what will happen, and only a yes there opens the existing
 * resend dialog (which sends nothing until its own Send) or the rule editor (which saves nothing until Save).
 */
@Component({
  selector: 'app-chat-consent',
  standalone: true,
  template: `
    @if (consent(); as c) {
      <div class="chat-consent" [class.done]="!!c.decided">
        <span class="ic">{{ c.kind === 'rule' ? '⚡' : '↻' }}</span>
        <span class="txt">{{ c.summary || (c.kind === 'rule' ? 'An interception rule' : 'A resend') }}</span>
        @if (c.decided) {
          <span class="st">{{ c.decided === 'yes' ? 'you said yes' : 'you said no' }}</span>
        } @else if (editable()) {
          <button type="button" class="board-tog on" (click)="review(c)">Review…</button>
          <button type="button" class="board-link" (click)="decide(false)">No</button>
        }
      </div>
      @if (error(); as e) { <div class="board-error" role="alert">{{ e }}</div> }
    }`,
})
export class ChatConsentComponent {
  private readonly api = inject(ChatApiService);
  private readonly calls = inject(CallsApiService);
  private readonly consentDialog = inject(ConsentService);
  private readonly resend = inject(ResendDialogService);
  private readonly rules = inject(RuleDraftService);
  private readonly router = inject(Router);
  private readonly state = inject(ChatStateService);
  readonly message = input.required<ChatMessage>();
  readonly editable = input(true);
  readonly error = signal<string | null>(null);

  readonly consent = computed<(ChatConsent & { call?: string }) | null>(() => {
    const c = (this.message().extra as { consent?: unknown } | null)?.consent as (ChatConsent & { call?: string }) | undefined;
    return c && (c.kind === 'resend' || c.kind === 'rule') ? c : null;
  });

  async review(c: ChatConsent & { call?: string }): Promise<void> {
    const ref = callOf({ type: 'call', ref: String(c.call ?? '').replace(/^@?\[?call:/, '').replace(/\|.*$/, ''), label: '' } as MentionRef);
    if (!ref) {
      this.error.set('Claude named no call to start from');
      return;
    }
    const resend = c.kind === 'resend';
    const ok = await this.consentDialog.ask({
      title: resend ? 'Resend a recorded call' : 'Draft an interception rule',
      from: "Claude's proposal in the board chat",
      lines: resend
        ? ['Open the resend dialog with this call, as Claude prepared it', 'Nothing is sent until you press Send there']
        : ['Open the rule editor with a new rule started from this call', 'Nothing is saved until you save it there'],
      exact: c.summary ?? null,
      confirmLabel: resend ? 'Open the resend dialog' : 'Open the editor',
    });
    if (!ok) return;
    try {
      const source = ref.direction === 'in' ? 'internal' : 'external';
      const summary = await firstValueFrom(this.calls.getSummary(ref.id, source));
      if (resend) {
        const detail = await firstValueFrom(this.calls.getDetail(ref.id, source));
        this.resend.open({ ...summary, ...detail, source }, ref.cycleId);
      } else {
        this.rules.start({ ...summary, source });
        await this.router.navigate(['/interception']);
      }
      this.decide(true);
    } catch (e) {
      this.error.set(messageOf(e));
    }
  }

  decide(yes: boolean): void {
    const m = this.message();
    this.api.consent(m.id, yes).subscribe({
      next: () => { this.error.set(null); this.state.changedLocally(m.scope); },
      error: (e) => this.error.set(messageOf(e)),
    });
  }
}
