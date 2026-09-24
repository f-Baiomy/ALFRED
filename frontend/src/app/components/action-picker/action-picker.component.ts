import { AfterViewInit, Component, ElementRef, computed, input, output, signal, viewChild } from '@angular/core';
import { ActionType, isTerminalAction } from '../../core/models/interception.model';
import { HelpEntry, helpForAction } from '../../shared/utils/interception-help';
import { HelpPopoverComponent } from '../help-popover/help-popover.component';
import { SvgIconComponent } from '../../shared/components/svg-icon/svg-icon.component';
import {
  ActionGoal,
  GOALS,
  PickContext,
  PickItem,
  RECIPES,
  Recipe,
  blockedReason,
  fitsRule,
  pickItems,
} from '../../shared/utils/action-catalog';

export type ActionPick = { readonly kind: 'action'; readonly type: ActionType } | { readonly kind: 'recipe'; readonly recipe: Recipe };

/**
 * The rule editor's "Add action" menu: every action the lane (or branch) can take, filed under
 * groups, narrowed by a goal ("Make it slow"…) and a search; each has an ⓘ with the same help
 * its card shows once added.
 * Actions the rule would refuse are shown greyed with the reason rather than hidden, and ones that
 * suit the rule's body are tagged. Arrow keys move, Enter adds, Esc closes. What to insert and
 * where is the editor's business - this only says what was picked.
 */
@Component({
  selector: 'app-action-picker',
  standalone: true,
  imports: [HelpPopoverComponent, SvgIconComponent],
  templateUrl: './action-picker.component.html',
})
export class ActionPickerComponent implements AfterViewInit {
  readonly phase = input.required<'request' | 'response'>();
  /** The action types allowed here (the lane's, or what a branch may nest). */
  readonly types = input.required<readonly ActionType[]>();
  readonly labels = input.required<Readonly<Record<ActionType, string>>>();
  readonly context = input.required<PickContext>();
  /** "as step 3 of the request lane" - where the pick lands. */
  readonly position = input('');
  /** Recipes only at the top level: they add answers and pauses a branch may already hold. */
  readonly showRecipes = input(true);

  readonly picked = output<ActionPick>();
  readonly closed = output<void>();

  readonly goals = GOALS;
  readonly goal = signal<ActionGoal | 'all'>('all');
  readonly query = signal('');
  readonly highlight = signal(0);

  private readonly search = viewChild<ElementRef<HTMLInputElement>>('search');

  readonly items = computed(() => pickItems(this.phase(), this.types(), this.labels(), this.goal(), this.query()));
  /** The goals that still have something to show, so a goal chip never leads to an empty menu. */
  readonly usefulGoals = computed(() =>
    this.goals.filter((g) => g.id === 'all' || pickItems(this.phase(), this.types(), this.labels(), g.id, '').length > 0)
  );
  readonly groups = computed(() => {
    const out: { label: string; icon: string; items: { item: PickItem; index: number }[] }[] = [];
    this.items().forEach((item, index) => {
      const last = out[out.length - 1];
      if (last && last.label === item.group.label) last.items.push({ item, index });
      else out.push({ label: item.group.label, icon: item.group.icon, items: [{ item, index }] });
    });
    return out;
  });
  readonly current = computed(() => this.items()[this.highlight()] ?? null);
  readonly recipes = computed(() => (this.showRecipes() ? RECIPES[this.phase()] : []));

  ngAfterViewInit(): void {
    this.search()?.nativeElement.focus();
  }

  /** The same "what does this do" the action's card shows once added. */
  help(type: ActionType): readonly HelpEntry[] {
    const entry = helpForAction(type);
    return entry ? [entry] : [];
  }

  blocked(type: ActionType): string | null {
    return blockedReason(type, this.context());
  }

  fits(type: ActionType): boolean {
    return fitsRule(type, this.context());
  }

  /** Answers the call itself - the host is never reached after it. */
  terminal(type: ActionType): boolean {
    return isTerminalAction(type);
  }

  /** Highlights the first action whose NAME matches - a hint or group match ranks after it. */
  setQuery(value: string): void {
    this.query.set(value);
    const q = value.trim().toLowerCase();
    const best = q ? this.items().findIndex((i) => this.labels()[i.type].toLowerCase().includes(q)) : 0;
    this.highlight.set(Math.max(0, best));
  }

  setGoal(goal: ActionGoal | 'all'): void {
    this.goal.set(goal);
    this.highlight.set(0);
  }

  choose(type: ActionType): void {
    if (this.blocked(type)) return;
    this.picked.emit({ kind: 'action', type });
  }

  chooseRecipe(recipe: Recipe): void {
    this.picked.emit({ kind: 'recipe', recipe });
  }

  onKey(event: KeyboardEvent): void {
    const count = this.items().length;
    switch (event.key) {
      case 'ArrowDown':
        this.highlight.set(Math.min(count - 1, this.highlight() + 1));
        break;
      case 'ArrowUp':
        this.highlight.set(Math.max(0, this.highlight() - 1));
        break;
      case 'Enter': {
        const item = this.current();
        if (item) this.choose(item.type);
        break;
      }
      case 'Escape':
        this.closed.emit();
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  }
}
