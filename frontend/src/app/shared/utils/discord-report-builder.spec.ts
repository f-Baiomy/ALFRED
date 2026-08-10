import { ExportFormData } from '../../core/models/export-metadata.model';
import { buildDiscordReport } from './discord-report-builder';

function makeForm(overrides: Partial<ExportFormData> = {}): ExportFormData {
  return {
    supplierName: 'Galileo',
    credentialsUsed: 'EGY',
    apiKey: 'ttdb2dc2-58c5-481c-84b5-95350a3a7978-f61360c2-f536-4b19-9a25-97b8f17ce4dc',
    url: 'https://ndc-integration-stg-ne-3.azurewebsites.net/',
    environment: 'Staging',
    description: 'The contactRefId returned for the passenger does not match any key in the contacts object of the Retrieve PNR response.',
    ...overrides,
  };
}

describe('buildDiscordReport', () => {
  it('matches the team\'s standard Discord bug-report template exactly', () => {
    const report = buildDiscordReport(makeForm());
    expect(report).toBe(
      'Supplier name: Galileo\n' +
      '\n' +
      'Supplier credentials used: EGY\n' +
      '\n' +
      'Environment (Production or Staging): STG\n' +
      '\n' +
      'URL:\n' +
      'https://ndc-integration-stg-ne-3.azurewebsites.net/\n' +
      '\n' +
      'API Key:\n' +
      'ttdb2dc2-58c5-481c-84b5-95350a3a7978-f61360c2-f536-4b19-9a25-97b8f17ce4dc\n' +
      '\n' +
      'Clear description of the issue/bug:\n' +
      '\n' +
      'Issue Summary\n' +
      '\n' +
      'The contactRefId returned for the passenger does not match any key in the contacts object of the Retrieve PNR response.\n' +
      '\n' +
      'check attached files to show the whole problem'
    );
  });

  it('abbreviates Production as PROD', () => {
    const report = buildDiscordReport(makeForm({ environment: 'Production' }));
    expect(report).toContain('Environment (Production or Staging): PROD');
  });
});
