import { Injectable, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { Observable, Subject, merge, of, timer } from 'rxjs';
import { catchError, filter, map, retry, shareReplay, switchMap, tap } from 'rxjs/operators';
import { webSocket } from 'rxjs/webSocket';
import {
  ActionTypeInfo,
  InterceptionRule,
  InterceptionRuleDraft,
  PauseDecision,
  PausedCall,
  RuleImportResult,
} from '../models/interception.model';
import { AppConfigService } from '../services/app-config.service';
import { InterceptionApiService } from '../services/interception-api.service';
import { copyName } from '../../shared/utils/interception-rules-file';

/**
 * Root-provided facade for the Interception tab. Fetch-on-demand driven by the /ws/interception
 * socket, exactly like ProfilesStateService - no polling, no timers.
 *
 * Two event types share one socket and are filtered apart here, because they have completely
 * different urgency and a shared "something changed" would make them interfere: a busy breakpoint
 * pushes several paused events a second, and treating those as a rules change would refetch the
 * whole rule list on every one of them for a list that did not change.
 *
 * Root-provided rather than owned by the page because the paused count drives a badge in the tab
 * bar, which is visible from every screen in the app - including ones where the Interception page
 * has never been opened. If somebody's connection is being held open, that has to be visible from
 * wherever you happen to be standing.
 */
@Injectable({ providedIn: 'root' })
export class InterceptionStateService {
  private readonly api = inject(InterceptionApiService);
  private readonly config = inject(AppConfigService);

  private readonly rulesRefresh = new Subject<void>();
  private readonly pausedRefresh = new Subject<void>();

  /** Payload-free pushes - see the backend's WebSocketInterceptionNotificationAdapter. */
  private readonly events$: Observable<string> = webSocket<{ type?: string }>(
    this.config.backendUrl.replace(/^http/, 'ws') + '/ws/interception'
  ).pipe(
    map((event) => event?.type ?? ''),
    retry({ delay: () => timer(3000) }),
    // One socket, two consumers: refCount keeps a single connection open rather than one per
    // subscriber, and drops it when the last one goes away.
    shareReplay({ bufferSize: 0, refCount: true })
  );

  // `of(null)` rather than the `timer(0)` the other state services open with: the initial fetch
  // fires synchronously on subscribe instead of on the next macrotask. Behaviourally identical in
  // the app (both fetch immediately), but it means a paused call is requested the instant this
  // service is constructed - which matters because the service is constructed by the app SHELL for
  // the tab badge, and a deferred first fetch leaves the badge blank for a tick on every load.
  private readonly rules$ = merge(
    of(null),
    this.rulesRefresh,
    this.events$.pipe(filter((type) => type === 'interception-rules-changed'))
  ).pipe(switchMap(() => this.api.listRules().pipe(catchError(() => of<InterceptionRule[]>([])))));

  private readonly paused$ = merge(
    of(null),
    this.pausedRefresh,
    this.events$.pipe(filter((type) => type === 'interception-paused-changed'))
  ).pipe(switchMap(() => this.api.listPaused().pipe(catchError(() => of<PausedCall[]>([])))));

  readonly rules = toSignal(this.rules$, { initialValue: [] as InterceptionRule[] });
  readonly pausedCalls = toSignal(this.paused$, { initialValue: [] as PausedCall[] });

  readonly actionTypes = toSignal(
    this.api.actionTypes().pipe(
      catchError(() => of<ActionTypeInfo[]>([])),
      shareReplay(1)
    ),
    { initialValue: [] as ActionTypeInfo[] }
  );

  private readonly masterSwitchState = signal(false);
  /** The one flag that turns the whole feature off without losing which rules were on. */
  readonly masterSwitch = this.masterSwitchState.asReadonly();

  private readonly savingState = signal(false);
  readonly saving = this.savingState.asReadonly();

  private readonly problemsState = signal<readonly string[]>([]);
  /** Every validation problem the backend found, not just the first - see InterceptionRulesController. */
  readonly problems = this.problemsState.asReadonly();

  readonly enabledRuleCount = computed(() => this.rules().filter((r) => r.enabled).length);

  /** Whether anything can actually touch traffic right now - what the banner reads. */
  readonly active = computed(() => this.masterSwitch() && this.enabledRuleCount() > 0);

  /** Rules that can hold a caller's connection open. Called out separately: these are the dangerous ones. */
  readonly pausingRuleCount = computed(
    () => this.rules().filter((r) => r.enabled && r.actions.some((a) => a.type.startsWith('PAUSE_'))).length
  );

  /**
   * Calls actually holding a caller's connection open right now.
   *
   * NOT the length of the list any more. A card follows its call past the half it was paused on -
   * in flight while the supplier works, then finished until you close it - and neither of those
   * has anybody waiting on the other end. Counting them here would make the tab badge shout about
   * calls nobody is waiting on, and a badge that cries wolf is a badge you learn to ignore.
   */
  readonly holdingCalls = computed(() => this.pausedCalls().filter((c) => (c.stage ?? 'holding') === 'holding'));

  readonly pausedCount = computed(() => this.holdingCalls().length);

  /** Released and forwarded; the supplier is working and the card is waiting for its answer. */
  readonly inFlightCount = computed(() => this.pausedCalls().filter((c) => c.stage === 'in-flight').length);

  /** Cycle over, nothing held, kept on screen until closed by hand. */
  readonly finishedCount = computed(() => this.pausedCalls().filter((c) => c.stage === 'finished').length);

  /** Calls somebody has taken control of - these are no longer counting down. */
  readonly heldCount = computed(() => this.holdingCalls().filter((c) => c.heldAt != null).length);

  constructor() {
    this.refreshMasterSwitch();
  }

  refreshMasterSwitch(): void {
    this.api
      .getMasterSwitch()
      .pipe(catchError(() => of({ enabled: false })))
      .subscribe((result) => this.masterSwitchState.set(result.enabled));
  }

  setMasterSwitch(enabled: boolean): void {
    this.api
      .setMasterSwitch(enabled)
      .pipe(catchError(() => of({ enabled: this.masterSwitchState() })))
      .subscribe((result) => this.masterSwitchState.set(result.enabled));
  }

  createRule(draft: InterceptionRuleDraft): Observable<InterceptionRule | null> {
    return this.withValidation(this.api.createRule(draft));
  }

  updateRule(id: string, draft: InterceptionRuleDraft): Observable<InterceptionRule | null> {
    return this.withValidation(this.api.updateRule(id, draft));
  }

  deleteRule(id: string): Observable<void> {
    return this.api.deleteRule(id).pipe(tap(() => this.refreshRules()));
  }

  setRuleEnabled(id: string, enabled: boolean): Observable<InterceptionRule> {
    return this.api.setRuleEnabled(id, enabled).pipe(tap(() => this.refreshRules()));
  }

  reorder(ids: readonly string[]): Observable<InterceptionRule[]> {
    return this.api.reorder(ids).pipe(tap(() => this.refreshRules()));
  }

  /**
   * Copies a rule. The copy keeps the original's enabled state and priority, so it lands next to
   * what it was copied from and behaves the way that rule does - you duplicate a rule to change
   * one thing about it, not to get a disabled skeleton you then have to remember to switch on.
   *
   * Note the consequence on a rule that DELAYS or PAUSES: two enabled copies act twice. The list
   * marks a pausing rule "holds the caller" for exactly this reason.
   */
  duplicateRule(rule: InterceptionRule): Observable<InterceptionRule | null> {
    return this.createRule({
      name: copyName(rule.name, this.rules().map((r) => r.name)),
      description: rule.description ?? null,
      enabled: rule.enabled,
      priority: rule.priority,
      stopProcessing: rule.stopProcessing,
      match: rule.match,
      actions: rule.actions,
    });
  }

  importRules(rules: readonly InterceptionRuleDraft[], enable: boolean): Observable<RuleImportResult> {
    return this.api.importRules(rules, enable).pipe(tap(() => this.refreshRules()));
  }

  takeControl(callId: string): Observable<void> {
    return this.api.takeControl(callId).pipe(tap(() => this.refreshPaused()));
  }

  decide(callId: string, decision: PauseDecision): Observable<void> {
    return this.api.decide(callId, decision).pipe(tap(() => this.refreshPaused()));
  }

  releaseAll(): Observable<{ released: number }> {
    return this.api.releaseAll().pipe(tap(() => this.refreshPaused()));
  }

  closeCard(callId: string): Observable<void> {
    return this.api.closeCard(callId).pipe(tap(() => this.refreshPaused()));
  }

  closeFinished(): Observable<{ closed: number }> {
    return this.api.closeFinished().pipe(tap(() => this.refreshPaused()));
  }

  clearProblems(): void {
    this.problemsState.set([]);
  }

  refreshRules(): void {
    this.rulesRefresh.next();
  }

  refreshPaused(): void {
    this.pausedRefresh.next();
  }

  /**
   * Turns a 400 into the `problems` signal rather than an error the caller has to handle. The
   * backend deliberately returns every problem with a rule at once, so the form can show all of
   * them instead of making the user fix one per round trip.
   */
  private withValidation(source: Observable<InterceptionRule>): Observable<InterceptionRule | null> {
    this.savingState.set(true);
    this.problemsState.set([]);
    return source.pipe(
      tap(() => {
        this.savingState.set(false);
        this.refreshRules();
      }),
      catchError((error: unknown) => {
        this.savingState.set(false);
        const body = (error as { error?: { problems?: string[] } })?.error;
        this.problemsState.set(body?.problems ?? ['Could not save this rule.']);
        return of(null);
      })
    );
  }
}
