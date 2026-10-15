import { Component, computed, inject, input, signal } from '@angular/core';
import { ChatMessage } from '../../../core/models/chat.models';
import { ChatApiService } from '../../../core/services/chat-api.service';
import { ChatStateService } from '../../../core/state/chat-state.service';
import { AskQuestion } from '../../../shared/utils/question-blocks';

/** A question Claude asked in a chat answer, with the user's answer once given. */
interface ChatQuestion extends AskQuestion {
  readonly answer?: string | null;
}

/**
 * Claude's questions in a chat answer (specs/022 FR-025), as on cards (specs/019): options that say what Claude then does,
 * the recommended one marked, several picks when allowed, Something else - answered all or some, and sent once. The
 * answers go back to Claude together as one message in the thread; what is left stays open.
 */
@Component({
  selector: 'app-chat-questions',
  standalone: true,
  template: `
    <div class="chat-qs">
      @for (q of questions(); track q.header) {
        <div class="chat-q" [class.done]="!!q.answer">
          <div class="chat-q-h"><b>{{ q.header }}</b> {{ q.question }}</div>
          @if (q.answer) {
            <div class="chat-q-a">✓ {{ q.answer }}</div>
          } @else {
            <div class="chat-q-opts">
              @for (o of q.options; track o.label) {
                <button type="button" class="board-tog" [class.on]="picked(q, o.label)" [disabled]="!editable()" [title]="o.then ?? o.description ?? ''"
                        (click)="pick(q, o.label)">{{ o.label }}@if (o.recommended) { <span class="board-dim"> · recommended</span> }</button>
              }
            </div>
            <input type="text" class="board-input" maxlength="2000" placeholder="Something else…" [disabled]="!editable()" [value]="other()[q.header] ?? ''"
                   (input)="setOther(q, $any($event.target).value)" />
          }
        </div>
      }
      @if (open() && editable()) {
        <div class="board-ev-acts">
          <button type="button" class="action-btn primary" [disabled]="!ready()" (click)="send()">
            Send {{ ready() }} answer{{ ready() === 1 ? '' : 's' }}</button>
          <span class="board-dim">answer all or some - the rest stay open</span>
        </div>
      }
    </div>`,
})
export class ChatQuestionsComponent {
  private readonly api = inject(ChatApiService);
  private readonly state = inject(ChatStateService);
  readonly message = input.required<ChatMessage>();
  readonly editable = input(true);

  readonly questions = computed<readonly ChatQuestion[]>(() => {
    const qs = (this.message().extra as { questions?: unknown } | null)?.questions;
    return Array.isArray(qs) ? (qs as ChatQuestion[]).filter((q) => q && typeof q.header === 'string' && Array.isArray(q.options)) : [];
  });
  readonly open = computed(() => this.questions().some((q) => !q.answer));
  readonly picks = signal<Readonly<Record<string, readonly string[]>>>({});
  readonly other = signal<Readonly<Partial<Record<string, string>>>>({});
  readonly answers = computed<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const q of this.questions()) {
      if (q.answer) continue;
      const parts = [...(this.picks()[q.header] ?? [])];
      const other = (this.other()[q.header] ?? '').trim();
      if (other) parts.push(other);
      if (parts.length) out[q.header] = parts.join(' + ');
    }
    return out;
  });
  readonly ready = computed(() => Object.keys(this.answers()).length);

  picked(q: ChatQuestion, label: string): boolean {
    return (this.picks()[q.header] ?? []).includes(label);
  }

  pick(q: ChatQuestion, label: string): void {
    const now = this.picks()[q.header] ?? [];
    const next = now.includes(label) ? now.filter((l) => l !== label) : q.multiSelect ? [...now, label] : [label];
    this.picks.set({ ...this.picks(), [q.header]: next });
  }

  setOther(q: ChatQuestion, text: string): void {
    this.other.set({ ...this.other(), [q.header]: text });
  }

  send(): void {
    const m = this.message();
    // A refusal shows in the panel; the picks stay so nothing is typed twice.
    this.state.run(this.api.answers(m.id, this.answers()), m.scope, () => {
      this.picks.set({});
      this.other.set({});
    });
  }
}
