import { ExportFormData } from '../../core/models/export-metadata.model';

/** The team's Discord bug-report convention abbreviates the form's own Production/Staging enum as
 * PROD/STG - not derived from anything else, just the agreed-on short form. */
function environmentAbbreviation(environment: ExportFormData['environment']): string {
  return environment === 'Staging' ? 'STG' : 'PROD';
}

/**
 * Builds the team's standard Discord bug-report message straight from the export form's fields -
 * the same fields already used for the Markdown/HTML export, so this is a different arrangement
 * of data the user already filled in, not a second form to fill out. "Issue Summary" is fixed
 * literal text (there's no such form field) that always precedes whatever the user typed in
 * Description - it's the section heading the team's Discord convention expects, not a value. The
 * closing line is likewise always the same fixed text, not derived from the form.
 */
export function buildDiscordReport(form: ExportFormData): string {
  return [
    `Supplier name: ${form.supplierName}`,
    '',
    `Supplier credentials used: ${form.credentialsUsed}`,
    '',
    `Environment (Production or Staging): ${environmentAbbreviation(form.environment)}`,
    '',
    'URL:',
    form.url,
    '',
    'API Key:',
    form.apiKey,
    '',
    'Clear description of the issue/bug:',
    '',
    'Issue Summary',
    '',
    form.description,
    '',
    'check attached files to show the whole problem',
  ].join('\n');
}
