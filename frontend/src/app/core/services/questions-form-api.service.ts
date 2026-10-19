import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpResponse } from '@angular/common/http';
import { Observable, map } from 'rxjs';
import { AppConfigService } from './app-config.service';
import { AnswersReport, FormBuilt, FormFormat, FormLang } from '../models/questions-form.models';

/** HTTP for the questions form and its answers file (specs/037): the form is a file, the import a report. */
@Injectable({ providedIn: 'root' })
export class QuestionsFormApiService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(AppConfigService);

  private get base(): string {
    return `${this.config.backendUrl}/board`;
  }

  /** The form file and what went into it (from its headers). */
  form(boardId: string, req: { cards: readonly number[]; lang: FormLang; title?: string | null; format: FormFormat }): Observable<{ blob: Blob; built: FormBuilt }> {
    return this.http.post(`${this.base}/boards/${encodeURIComponent(boardId)}/questions-form`,
      { cards: req.cards, lang: req.lang, title: req.title || null, format: req.format }, { observe: 'response', responseType: 'blob' })
      .pipe(map((r: HttpResponse<Blob>) => ({ blob: r.body ?? new Blob(), built: built(r, req.format) })));
  }

  importAnswers(boardId: string, req: { fileId: string; dryRun: boolean }): Observable<AnswersReport> {
    return this.http.post<AnswersReport>(`${this.base}/boards/${encodeURIComponent(boardId)}/answers-import`, req);
  }
}

function header(r: HttpResponse<unknown>, name: string): string {
  const v = r.headers.get(name);
  if (!v) return '';
  try {
    return decodeURIComponent(v.replace(/\+/g, ' '));
  } catch {
    return v;
  }
}

function built(r: HttpResponse<unknown>, format: FormFormat): FormBuilt {
  const leftOut = header(r, 'X-Alfred-Form-Left-Out');
  return {
    fileName: header(r, 'X-Alfred-Form-Name') || `questions.${format}`,
    formId: header(r, 'X-Alfred-Form-Id'),
    questions: Number(header(r, 'X-Alfred-Form-Questions') || 0),
    cards: header(r, 'X-Alfred-Form-Cards').split(',').filter(Boolean).map(Number),
    leftOut: leftOut ? leftOut.split('\n') : [],
    warning: header(r, 'X-Alfred-Form-Warning') || null,
    size: Number(header(r, 'X-Alfred-Form-Size') || 0),
  };
}
