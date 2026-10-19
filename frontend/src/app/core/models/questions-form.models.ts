/** The questions form and its answers file (specs/037, docs/board.md "Questions form"). */

export type FormLang = 'auto' | 'ar' | 'en';
export type FormFormat = 'html' | 'zip';

/** What Alfred said about a form it built (the response headers). */
export interface FormBuilt {
  readonly fileName: string;
  readonly formId: string;
  readonly questions: number;
  readonly cards: readonly number[];
  readonly leftOut: readonly string[];
  readonly warning: string | null;
  readonly size: number;
}

export type AnswerVerdict = 'APPLY' | 'APPLIED' | 'ALREADY_ANSWERED' | 'CHANGED' | 'UNKNOWN_KEY' | 'LATER' | 'NOT_ANSWERED' | 'REFUSED';

export interface AnswerChoice {
  readonly id: string;
  readonly label: string;
}

export interface AnswerRow {
  readonly q: string;
  readonly card: number | null;
  readonly header: string | null;
  readonly question: string | null;
  readonly choice: readonly AnswerChoice[];
  readonly other: boolean;
  readonly later: boolean;
  readonly note: string | null;
  readonly sure: string | null;
  readonly follow: { readonly header: string; readonly question: string | null; readonly choice: readonly AnswerChoice[] } | null;
  readonly result: AnswerVerdict;
  readonly message: string | null;
}

export interface AnswersReport {
  readonly file: {
    readonly formId: string; readonly board: string; readonly boardName: string | null; readonly answeredBy: string; readonly role: string;
    readonly answeredAt: string | null; readonly lang: string | null;
  };
  readonly rows: readonly AnswerRow[];
  readonly applied: number;
  readonly summary: Readonly<Partial<Record<AnswerVerdict, number>>>;
  readonly dryRun: boolean;
}

export const VERDICT_LABEL: Readonly<Record<AnswerVerdict, string>> = {
  APPLY: 'will apply', APPLIED: 'applied', ALREADY_ANSWERED: 'already answered', CHANGED: 'question withdrawn or changed',
  UNKNOWN_KEY: 'unknown key', LATER: 'later · stays open', NOT_ANSWERED: 'not answered · stays open', REFUSED: 'refused',
};

/** An answers file is an .html page or a .zip holding it - nothing else goes to the import. */
export function isAnswersFile(file: { readonly name: string } | null | undefined): boolean {
  return !!file && /\.(html?|zip)$/i.test(file.name);
}
