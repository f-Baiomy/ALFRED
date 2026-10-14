import { DestroyRef, Injectable, Signal, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { WidgetInfo } from '../models/snippet.models';
import { BoardSocketService } from './board-socket.service';
import { SnippetsApiService } from './snippets-api.service';

/** A widget as a text shows it: found (with its source), missing, or still loading. */
export type WidgetLookup = { readonly state: 'loading' } | { readonly state: 'missing'; readonly message: string } | { readonly state: 'ok'; readonly widget: WidgetInfo };

/** `{{key}}` in a widget's source → the value given where it is used; keys not given stay as written. */
export function fillWidget(source: string, params: Readonly<Record<string, string>>): string {
  return source.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (all, key: string) => (Object.prototype.hasOwnProperty.call(params, key) ? params[key] : all));
}

/**
 * A project's widgets for the texts that use them (specs/017 R34): each read once and kept, and read again when /ws/board
 * says the project's widgets changed - no polling.
 */
@Injectable({ providedIn: 'root' })
export class WidgetsService {
  private readonly api = inject(SnippetsApiService);
  private readonly cache = new Map<string, ReturnType<typeof signal<WidgetLookup>>>();

  constructor() {
    const sub = inject(BoardSocketService).events$.subscribe((e) => {
      if (e.type !== 'board-changed' || e.what !== 'widgets') return;
      for (const [key, slot] of this.cache) {
        const [project, name] = JSON.parse(key) as [string, string];
        if (project === (e.project ?? '')) void this.fetch(project, name, slot);
      }
    });
    inject(DestroyRef).onDestroy(() => sub.unsubscribe());
  }

  get(project: string, name: string): Signal<WidgetLookup> {
    const key = JSON.stringify([project, name]);
    let slot = this.cache.get(key);
    if (!slot) {
      slot = signal<WidgetLookup>({ state: 'loading' });
      this.cache.set(key, slot);
      void this.fetch(project, name, slot);
    }
    return slot.asReadonly();
  }

  private async fetch(project: string, name: string, slot: ReturnType<typeof signal<WidgetLookup>>): Promise<void> {
    try {
      slot.set({ state: 'ok', widget: await firstValueFrom(this.api.widget(project, name)) });
    } catch (e) {
      slot.set({ state: 'missing', message: (e as { error?: { message?: string } })?.error?.message ?? `No widget "${name}" in this project` });
    }
  }
}
