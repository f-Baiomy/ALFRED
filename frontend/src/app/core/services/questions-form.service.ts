import { Injectable, Injector, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { QuestionsFormApiService } from './questions-form-api.service';
import { SnippetsApiService } from './snippets-api.service';
import { AnswersReport, FormFormat, FormLang, isAnswersFile } from '../models/questions-form.models';
import { downloadBlob } from '../../shared/utils/download';

export interface FormPrefs {
  readonly lang: FormLang;
  readonly format: FormFormat;
}

export interface FormNote {
  readonly kind: 'ok' | 'warn' | 'error';
  readonly text: string;
}

/** An answers file read and checked, waiting for the user's Apply. */
export interface PendingImport {
  readonly boardId: string;
  readonly fileId: string;
  readonly fileName: string;
  readonly report: AnswersReport;
}

const PREFS_KEY = 'alfred.questionsForm.';

/**
 * The questions form from the board (specs/037): download it (all open questions, one card's, the selected cards'),
 * and bring an answers file back - kept on the board as a download, read by Alfred, shown as a report built from its
 * JSON (never the file's page), applied only when the user presses Apply. One instance for the app: the report dialog
 * ({@code app-answers-import}) is mounted once at the root, so the board, a card and the chat all open the same one.
 */
@Injectable({ providedIn: 'root' })
export class QuestionsFormService {
  // Resolved on first use: every card tile injects this service for its ⇩ Form button, and a tile must not need
  // HttpClient just to render.
  private readonly injector = inject(Injector);
  private get api(): QuestionsFormApiService { return this.injector.get(QuestionsFormApiService); }
  private get files(): SnippetsApiService { return this.injector.get(SnippetsApiService); }

  readonly busy = signal(false);
  readonly note = signal<FormNote | null>(null);
  readonly pending = signal<PendingImport | null>(null);
  readonly applying = signal(false);

  /** This page's choices - kept even when the browser stores nothing. */
  private readonly chosen = new Map<string, FormPrefs>();

  prefs(boardId: string): FormPrefs {
    const kept = this.chosen.get(boardId);
    if (kept) return kept;
    try {
      const raw = JSON.parse(localStorage.getItem(PREFS_KEY + boardId) ?? 'null') as Partial<FormPrefs> | null;
      return { lang: raw?.lang === 'ar' || raw?.lang === 'en' ? raw.lang : 'auto', format: raw?.format === 'zip' ? 'zip' : 'html' };
    } catch {
      return { lang: 'auto', format: 'html' };
    }
  }

  setPrefs(boardId: string, prefs: FormPrefs): void {
    this.chosen.set(boardId, prefs);
    try {
      localStorage.setItem(PREFS_KEY + boardId, JSON.stringify(prefs));
    } catch {
      // a browser that keeps nothing: the choice lasts this page only
    }
  }

  /** Builds the form and saves it. {@code cards}: card numbers, empty for every card with open questions. */
  async download(boardId: string, cards: readonly number[] = []): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.note.set(null);
    try {
      const p = this.prefs(boardId);
      const { blob, built } = await firstValueFrom(this.api.form(boardId, { cards, lang: p.lang, format: p.format }));
      downloadBlob(blob, built.fileName);
      const parts = [`Saved ${built.fileName}: ${built.questions} question${built.questions === 1 ? '' : 's'} on ${built.cards.length} card${built.cards.length === 1 ? '' : 's'}.`];
      if (built.leftOut.length) parts.push(`Not in it: ${built.leftOut.join('; ')}.`);
      if (built.warning) parts.push(built.warning + '.');
      this.note.set({ kind: built.warning || built.leftOut.length ? 'warn' : 'ok', text: parts.join(' ') });
    } catch (e) {
      this.note.set({ kind: 'error', text: await errorText(e, 'The questions form could not be made') });
    } finally {
      this.busy.set(false);
    }
  }

  /** Opens the file picker for an answers file. */
  pick(boardId: string, project: string): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.html,.htm,.zip,text/html,application/zip';
    input.addEventListener('change', () => {
      const f = input.files?.[0];
      if (f) void this.importFile(f, boardId, project);
    });
    input.click();
  }

  /** Keeps the file on the board (a download only) and shows what it would do. */
  async importFile(file: File, boardId: string, project: string): Promise<void> {
    if (!isAnswersFile(file)) {
      this.note.set({ kind: 'error', text: 'An answers file is the .html (or .zip) a questions form downloads.' });
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      this.note.set({ kind: 'error', text: 'An answers file is at most 2 MB' });
      return;
    }
    this.busy.set(true);
    this.note.set(null);
    try {
      const stored = await firstValueFrom(this.files.attach({ cycle: boardId, project }, file));
      const report = await firstValueFrom(this.api.importAnswers(boardId, { fileId: stored.id, dryRun: true }));
      this.pending.set({ boardId, fileId: stored.id, fileName: stored.name, report });
    } catch (e) {
      this.note.set({ kind: 'error', text: await errorText(e, 'The answers file could not be read') });
    } finally {
      this.busy.set(false);
    }
  }

  /** Records the answers that apply as the user's. */
  async apply(): Promise<void> {
    const p = this.pending();
    if (!p || this.applying()) return;
    this.applying.set(true);
    try {
      const report = await firstValueFrom(this.api.importAnswers(p.boardId, { fileId: p.fileId, dryRun: false }));
      this.pending.set({ ...p, report });
      this.note.set({ kind: 'ok', text: `${report.applied} answer${report.applied === 1 ? '' : 's'} recorded on the cards.` });
    } catch (e) {
      this.note.set({ kind: 'error', text: await errorText(e, 'The answers could not be applied') });
    } finally {
      this.applying.set(false);
    }
  }

  close(): void {
    this.pending.set(null);
  }
}

/** The backend's message, also when the body came back as a Blob (the form is asked for as one). */
async function errorText(e: unknown, fallback: string): Promise<string> {
  if (e instanceof HttpErrorResponse) {
    let body: unknown = e.error;
    if (body instanceof Blob) {
      try {
        body = JSON.parse(await body.text());
      } catch {
        body = null;
      }
    }
    const msg = body && typeof body === 'object' ? ((body as { message?: string; error?: string }).message ?? (body as { error?: string }).error) : null;
    if (msg) return msg;
    if (e.status === 0) return `${fallback}: Alfred is not reachable`;
    return `${fallback} (${e.status})`;
  }
  return fallback;
}
