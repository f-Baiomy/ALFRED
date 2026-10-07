import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { StoreCommandSummary } from '../../core/models/store-command.model';
import { StoreGroupItem, StoreItem } from '../../shared/utils/store-command-tree';
import { msText } from '../../shared/utils/db-statement-display';
import { DbWindowState } from './db-window-state';
import { StoreCommandDetailComponent } from './store-command-detail.component';

/**
 * The Redis view's rows (specs/011-redis-capture mock section 3): one `.r.rd-row` per command - number, command
 * (read / write / failed colour), the Spring Cache tag, key and arguments, the reply (hit green, miss amber, error red),
 * time (slow highlighted) and offset - and `.g` groups for single reads one by one, transactions and pipelines,
 * folded at first. A command opens to its detail. Also the rows Together places among the statements.
 */
@Component({
  standalone: true,
  selector: 'app-store-command-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [StoreCommandDetailComponent, NgTemplateOutlet],
  template: `
    @for (item of shown(); track item.kind + item.seq) {
      @if (item.kind === 'cmd') {
        <ng-container *ngTemplateOutlet="row; context: { $implicit: item.cmd }" />
      } @else {
        @let g = asGroup(item);
        <div class="g query" [class.closed]="!state.redisUnfolded().has(g.key)">
          <div class="rh" (click)="state.toggleRedisFold(g.key)" [attr.data-group]="g.key" [attr.data-seq]="g.seq">
            <span class="chev" [style.transform]="state.redisUnfolded().has(g.key) ? 'rotate(90deg)' : null">▶</span>
            <span class="num">#{{ g.seq }}</span>
            <span class="verb" [class]="'verb ' + g.verbClass">{{ g.verb }}</span>
            <span class="lbl"><span class="rkey">{{ g.pattern }}</span> <span class="meta">{{ g.meta }}</span></span>
            <span class="res">#{{ g.seq }}–#{{ g.lastSeq }}</span>
            <span class="ms">{{ ms(g.micros) }}</span>
            <span class="off">+{{ offset(g.commands[0]) }} ms</span>
            @if (g.warn) {<span class="g-warn">{{ g.warn }}</span>}
          </div>
          @if (state.redisUnfolded().has(g.key)) {
            <div class="gb">
              @for (c of g.commands; track c.seq) {
                @if (state.matchesRedis(c)) {<ng-container *ngTemplateOutlet="row; context: { $implicit: c }" />}
              }
            </div>
          }
        </div>
      }
    }
    <ng-template #row let-c>
      <div class="r rd-row" [class.fail]="c.outcome === 'FAILED'" [class.flash]="state.flashSeq() === c.seq" [attr.data-seq]="c.seq">
        <div class="rh" (click)="state.toggleRedisOpen(c.seq)">
          <span class="chev" [style.transform]="state.redisOpen().has(c.seq) ? 'rotate(90deg)' : null">▶</span>
          <span class="num">#{{ c.seq }}</span>
          <span class="verb" [class]="'verb ' + verbClass(c)" [title]="c.command">{{ c.command }}</span>
          <span class="rkey" [title]="c.keys.join(' ')">@if (c.origin?.cache) {<span class="orig spc" [title]="'Sent by Spring Cache - ' + c.origin.operation + ' on cache ' + c.origin.cache">{{ c.origin.operation === 'cache put' ? 'PUT' : c.origin.operation === 'evict' ? 'EVICT' : 'CACHE' }}</span>}{{ keysText(c) }}@if (c.argsText) {<span class="arg">{{ c.argsText }}</span>}</span>
          <span class="res rres" [class]="'res rres ' + resClass(c)" [title]="c.error ?? ''">{{ c.outcome === 'FAILED' && c.error ? short(c.error) : c.replyPreview }}</span>
          <span class="ms" [class.mid]="c.micros > state.redisSlowMillis() * 1000">{{ ms(c.micros) }}</span>
          <span class="off">+{{ offset(c) }} ms</span>
        </div>
        @if (state.redisOpen().has(c.seq)) {
          <app-store-command-detail [command]="c" />
        }
      </div>
    </ng-template>
  `,
})
export class StoreCommandListComponent {
  protected readonly state = inject(DbWindowState);
  readonly items = input.required<readonly StoreItem[]>();

  /** Items with anything left under the filters (a group shows while one of its commands does). */
  readonly shown = computed(() => this.items().filter((i) => (i.kind === 'cmd' ? this.state.matchesRedis(i.cmd) : i.commands.some((c) => this.state.matchesRedis(c)))));

  protected asGroup(item: StoreItem): StoreGroupItem {
    return item as StoreGroupItem;
  }

  protected verbClass(c: StoreCommandSummary): string {
    return c.outcome === 'FAILED' ? 'v-rx' : c.rw === 'r' ? 'v-rr' : 'v-rw';
  }

  protected resClass(c: StoreCommandSummary): string {
    switch (c.outcome) {
      case 'HIT': return 'r-hit';
      case 'MISS': return 'r-miss';
      case 'FAILED': return 'r-err';
      default: return 'r-plain';
    }
  }

  protected keysText(c: StoreCommandSummary): string {
    const shown = c.keys.slice(0, 3).join(' ');
    return c.keysTotal > 3 ? `${shown} … +${c.keysTotal - 3} keys` : shown;
  }

  protected short(text: string): string {
    return text.length > 40 ? text.slice(0, 39) + '…' : text;
  }

  protected ms(micros: number): string {
    return msText(micros);
  }

  /** Milliseconds from the call's start. */
  protected offset(c: StoreCommandSummary): number {
    const call = this.state.call();
    if (!call) return 0;
    return Math.max(0, Math.round(Date.parse(c.at) - Date.parse(call.timestamp)));
  }
}
