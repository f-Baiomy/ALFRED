import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { DbCaptureApiService } from '../../core/services/db-capture-api.service';
import { CallFocusService } from '../../core/services/call-focus.service';
import { DecodedValue, KeyHistoryRow, StoreCommand, StoreCommandSummary } from '../../core/models/store-command.model';
import { TraceHit } from '../../core/models/db-capture.model';
import { msText } from '../../shared/utils/db-statement-display';
import { fmtMs } from '../../shared/utils/db-findings';
import { DbWindowState } from './db-window-state';
import { DbWindowService } from './db-window.service';

/** Values worth tracing from a key or a value: ids, codes, numbers - not words like "rule" or "cache". */
export function traceCandidates(keys: readonly string[], valueText: string | null | undefined): string[] {
  const out = new Set<string>();
  const add = (v: string) => {
    if (/^\d{2,}$/.test(v) || /^[0-9a-f]{8,}$/i.test(v) || /^[A-Z0-9]{2,6}$/.test(v) || /^[A-Z]{2,4}-?\d+$/i.test(v)) out.add(v);
  };
  for (const k of keys) k.split(/[:._-]/).forEach(add);
  for (const m of (valueText ?? '').slice(0, 20000).matchAll(/"([^"\\]{2,40})"/g)) {
    if (out.size >= 6) break;
    add(m[1]);
  }
  return [...out].slice(0, 6);
}

/**
 * One Redis command opened (specs/011-redis-capture FR-020, mock section 3): the full command, the reply, the Spring
 * Cache origin, the value format, value before the write, the round trip, the client/connection/pool wait, thread and
 * code line; "Written by" for a hit; the value decoded (Decoded / Raw bytes); values to trace; redis-cli and the key's
 * history. Masked keys never show a value. Everything comes from the backend - nothing is decoded in the browser.
 */
@Component({
  standalone: true,
  selector: 'app-store-command-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="rd-detail">
      @if (detail(); as d) {
        <div class="kv">
          <span>command</span><span>{{ d.args.join(' ') }}</span>
          <span>reply</span><span>{{ replyLine(d) }}</span>
          @if (d.row.origin?.cache || d.row.origin?.method) {
            <span>spring cache</span><span><b>{{ d.row.origin?.cache ?? '' }}</b>{{ d.row.origin?.operation ? ' · ' + d.row.origin?.operation : '' }}{{ d.row.origin?.method ? ' · ' + d.row.origin?.method : '' }}</span>
          }
          @if (shownValue(); as v) {
            <span>value format</span><span>{{ v.masked ? 'masked' : v.format }}{{ v.partial ? ' (part shown as bytes)' : '' }}</span>
            <span>value size</span><span>{{ size(v.bytes) }}</span>
          }
          @if (d.before || d.row.beforeNote) {
            <span>before the write</span><span style="color:var(--amber)">{{ beforeLine(d) }}</span>
          }
          <span>sent / reply</span><span>+{{ offset() }} ms · {{ ms(d.row.micros) }} round trip{{ d.row.group?.kind === 'tx' ? ' (one round trip for the whole MULTI … EXEC)' : d.row.group?.kind === 'pipeline' ? ' (one round trip for the pipeline)' : '' }}</span>
          <span>client</span><span>{{ d.row.client ?? '?' }}{{ d.row.connection ? ' · ' + d.row.connection : '' }} · pool wait {{ d.row.poolWaitMicros != null ? ms(d.row.poolWaitMicros) : '- (no pool)' }}{{ d.server ? ' · ' + d.server : '' }} db {{ d.db ?? 0 }}</span>
          @if (d.thread) {<span>thread</span><span>{{ d.thread }}</span>}
          @if (d.row.code) {<span>code</span><span class="code" [title]="(d.callers ?? []).join('\\n')">{{ d.row.code }} ↗</span>}
        </div>
        @if (d.writtenBy; as w) {
          <div class="rd-src">
            @if (w.none) {
              <span class="faint">Written by: {{ w.none }}</span>
            } @else {
              <span class="faint">Written by</span>
              <b>{{ w.command ?? 'write' }} by {{ w.method ?? '' }} {{ w.path ?? ('call ' + short(w.callId)) }}{{ w.status ? ' · ' + w.status : '' }}</b>
              <span class="faint">· {{ ago(w.agoMillis) }} before this call · call {{ short(w.callId) }}…</span>
              <a (click)="showWriter(w.callId!)">show call ↗</a>
              @if (w.sameValue === true) {<span class="tag ok">same value as written ✓</span>}
              @if (w.sameValue === false) {<span class="tag warn">value changed since</span>}
            }
          </div>
        }
        @if (shownValue(); as v) {
          @if (v.masked) {
            <pre>‹masked · {{ v.bytes.toLocaleString() }} B›  (key matches a masked pattern - stored in full, masked on screen)</pre>
          } @else {
            <div class="rd-fmt"><a [class.on]="!raw()" (click)="setRaw(false)">Decoded</a><a [class.on]="raw()" (click)="setRaw(true)">Raw bytes</a>
              <span class="faint">stored as raw bytes · shown {{ raw() ? 'raw' : 'decoded' }}</span></div>
            <pre>{{ raw() ? rawText() : v.text }}</pre>
          }
        }
        @if (candidates().length) {
          <div class="rd-trace"><span class="faint">Trace a value:</span>
            @for (t of candidates(); track t) {<a class="tv" [class.on]="traced() === t" (click)="trace(t)">{{ t }}</a>}
            <div class="tr-out">@if (traced(); as t) {<b>{{ t }}</b> also appears in:@for (h of traceRows(); track $index) {<div><span class="w">{{ h.where }}</span>{{ h.what }}</div>}@if (!traceRows().length) { <span class="faint">nowhere else in this call</span>}}</div>
          </div>
        }
        <div class="foot">
          <a (click)="copyCli()">Copy as redis-cli</a>
          @if (d.row.keys.length) {<a (click)="toggleHistory()">Every call that used this key ↗</a>}
          @if (d.row.micros > state.redisSlowMillis() * 1000) {<span class="tag warn">slow - over {{ state.redisSlowMillis() }} ms</span>}
          @if (note()) {<span class="faint">{{ note() }}</span>}
        </div>
        @if (history(); as hs) {
          <div class="rd-hist">
            @for (h of hs; track $index) {
              <div><span class="op">{{ h.op }}</span><span>{{ when(h.at) }}</span><span>{{ h.command ?? '' }} {{ h.outcome ?? '' }}</span>
                <span class="faint">{{ h.method ?? '' }} {{ h.path ?? '' }}{{ h.status ? ' · ' + h.status : '' }} · call {{ short(h.callId) }}…</span>
                @if (h.sameValueAsPrevious === false) {<span class="tag warn">value changed</span>}</div>
            }
            @if (!hs.length) {<div class="faint">No other recorded call used this key.</div>}
          </div>
        }
      } @else if (error()) {
        <span class="faint">{{ error() }}</span>
      } @else {
        <span class="faint">Loading…</span>
      }
    </div>
  `,
})
export class StoreCommandDetailComponent implements OnInit {
  private readonly api = inject(DbCaptureApiService);
  private readonly focus = inject(CallFocusService);
  private readonly windows = inject(DbWindowService);
  protected readonly state = inject(DbWindowState);

  readonly command = input.required<StoreCommandSummary>();
  readonly detail = signal<StoreCommand | null>(null);
  readonly error = signal<string | null>(null);
  readonly raw = signal(false);
  private readonly rawDetail = signal<StoreCommand | null>(null);
  readonly traced = signal<string | null>(null);
  readonly traceRows = signal<readonly { where: string; what: string }[]>([]);
  readonly history = signal<readonly KeyHistoryRow[] | null>(null);
  readonly note = signal<string | null>(null);

  /** The value a person wants to read: what a write stored, else the reply. */
  readonly shownValue = computed<DecodedValue | null>(() => {
    const d = this.detail();
    if (!d) return null;
    return d.value ?? d.reply ?? null;
  });
  readonly candidates = computed(() => {
    const d = this.detail();
    return d && !this.shownValue()?.masked ? traceCandidates(d.row.keys, this.shownValue()?.text) : [];
  });
  readonly rawText = computed(() => {
    const r = this.rawDetail();
    const v = r ? r.value ?? r.reply : null;
    return v?.rawBase64 ? hex(v.rawBase64) : 'Loading…';
  });

  ngOnInit(): void {
    this.raw.set(this.state.redisShowRaw());
    this.api.storeCommand(this.command().id).subscribe({
      next: (d) => this.detail.set(d),
      error: () => this.error.set('Could not load the command.'),
    });
    if (this.raw()) this.loadRaw();
  }

  setRaw(raw: boolean): void {
    this.raw.set(raw);
    if (raw) this.loadRaw();
  }

  private loadRaw(): void {
    if (this.rawDetail()) return;
    this.api.storeCommand(this.command().id, true).subscribe({ next: (d) => this.rawDetail.set(d), error: () => undefined });
  }

  protected replyLine(d: StoreCommand): string {
    if (d.row.outcome === 'FAILED') return `${d.row.error ?? 'failed'} - the app got an error reply`;
    if (d.reply?.masked) return `‹masked · ${d.reply.bytes.toLocaleString()} B›`;
    return d.row.replyPreview ?? '';
  }

  protected beforeLine(d: StoreCommand): string {
    const v = d.before;
    const text = v ? (v.masked ? `‹masked · ${v.bytes.toLocaleString()} B›` : v.text ?? '') : '';
    const value = text.length > 160 ? text.slice(0, 159) + '…' : text;
    return [value, d.row.beforeNote].filter((x) => !!x).join(' · ');
  }

  protected offset(): number {
    const call = this.state.call();
    return call ? Math.max(0, Math.round(Date.parse(this.command().at) - Date.parse(call.timestamp))) : 0;
  }

  protected ms(micros: number): string {
    return msText(micros);
  }

  protected size(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  protected short(id: string | null | undefined): string {
    return (id ?? '').slice(0, 8);
  }

  protected ago(ms: number | null | undefined): string {
    return ms == null ? '?' : fmtMs(ms);
  }

  protected when(at: string): string {
    const d = new Date(at);
    return Number.isNaN(d.getTime()) ? at : d.toLocaleString();
  }

  showWriter(callId: string): void {
    this.windows.putAside(`Redis writer ${callId.slice(0, 8)}`);
    this.focus.go({ callId, cycleId: null, direction: 'inbound', serviceName: this.state.project() });
  }

  copyCli(): void {
    const call = this.state.call();
    if (!call) return;
    this.api.redisCli(call.id, [this.command().seq]).subscribe((text) => {
      void navigator.clipboard?.writeText(text).then(() => this.flash('Copied'));
    });
  }

  toggleHistory(): void {
    if (this.history()) {
      this.history.set(null);
      return;
    }
    const key = this.command().keys[0];
    this.api.keyHistory(this.state.project(), key, 50).subscribe({ next: (rows) => this.history.set(rows), error: () => this.history.set([]) });
  }

  /** Where else the value appears: the backend's trace (statements, rows, Redis) and the call's own bodies. */
  trace(value: string): void {
    if (this.traced() === value) {
      this.traced.set(null);
      return;
    }
    this.traced.set(value);
    this.traceRows.set([]);
    const call = this.state.call();
    if (!call) return;
    const bodies: { where: string; what: string }[] = [];
    if (call.request?.body?.includes(value)) bodies.push({ where: 'Request', what: 'body' });
    if (call.response?.body?.includes(value)) bodies.push({ where: 'Response', what: 'body' });
    for (const [seq, sup] of this.state.suppliersBySeq()) {
      if (sup.request?.body?.includes(value)) bodies.push({ where: `Supplier #${seq}`, what: 'request body' });
      if (sup.response?.body?.includes(value)) bodies.push({ where: `Supplier #${seq}`, what: 'response body' });
    }
    this.api.trace(call.id, value).subscribe({
      next: (r) => {
        if (this.traced() !== value) return;
        const own = this.command().seq;
        const hits = r.hits.filter((h) => !(h.seq === own && h.where.startsWith('REDIS'))).map((h) => describe(h));
        this.traceRows.set([...hits, ...bodies]);
      },
      error: () => this.traceRows.set(bodies),
    });
  }

  private flash(text: string): void {
    this.note.set(text);
    setTimeout(() => this.note.set(null), 1500);
  }
}

function describe(h: TraceHit): { where: string; what: string } {
  switch (h.where) {
    case 'REDIS_KEY': return { where: `Redis #${h.seq}`, what: `key ${h.column ?? ''}` };
    case 'REDIS_ARG': return { where: `Redis #${h.seq}`, what: `argument ${h.index}${h.column ? ' ' + h.column : ''}` };
    case 'REDIS_REPLY': return { where: `Redis #${h.seq}`, what: `reply${h.column ? ' ' + h.column : ''}` };
    case 'REDIS_BEFORE': return { where: `Redis #${h.seq}`, what: 'value before the write' };
    case 'PARAM': return { where: `DB #${h.seq}`, what: `parameter ${h.index + 1}` };
    case 'ROW': return { where: `DB #${h.seq}`, what: `result row ${h.index + 1}${h.column ? ', ' + h.column : ''}` };
    case 'BEFORE_IMAGE': return { where: `DB #${h.seq}`, what: 'before-image row' };
    case 'KEY': return { where: `DB #${h.seq}`, what: 'generated key' };
    default: return { where: `#${h.seq}`, what: h.where.toLowerCase() };
  }
}

/** Base64 as hex, 32 bytes a line - the Raw bytes view. */
export function hex(base64: string): string {
  const bin = atob(base64);
  const out: string[] = [];
  for (let i = 0; i < bin.length; i++) {
    out.push(bin.charCodeAt(i).toString(16).padStart(2, '0') + (i % 32 === 31 ? '\n' : ' '));
  }
  return out.join('').trimEnd();
}
