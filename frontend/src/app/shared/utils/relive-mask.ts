/**
 * Masks Relive text for display (FR-022/022a). The backend returns bodies, headers and variable
 * values in full plus `secrets: string[]` (the cycle's own secret variable names) - masking is
 * the frontend's job here exactly as everywhere else in ALFRED.
 *
 * Reuses `redact.ts`'s existing global secret-value masking (`redactSecrets`) rather than
 * duplicating it, then additionally masks every value of a variable this cycle marked secret.
 * `redact.ts` itself is untouched - it doesn't know Relive exists.
 */
import { redactSecrets } from './redact';

const MASKED = '•••';

export function maskRelive(text: string, secrets: readonly string[], values: Readonly<Record<string, string>>): string {
  let out = redactSecrets(text);
  for (const name of secrets) {
    const value = values[name];
    if (value) {
      out = out.split(value).join(MASKED);
    }
  }
  return out;
}
