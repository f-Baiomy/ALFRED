import { diffLines, diffSummary, plainText } from './item-diff';

describe('item-diff (specs/028 US2)', () => {
  it('reads tracker HTML as plain text without cutting it', () => {
    const long = '<p>' + 'x'.repeat(5000) + '</p>';
    expect(plainText('<div>Pay&nbsp;<b>fails</b> &amp; retries</div>')).toBe('Pay fails & retries');
    expect(plainText(long).length).toBe(5000);
  });

  it('puts state and title first, drops fields equal after cleaning, and names the kind', () => {
    const lines = diffLines([
      { field: 'System.Description', from: '<p>a</p>', to: 'a' },
      { field: 'Microsoft.VSTS.Common.Priority', from: null, to: '2' },
      { field: 'System.Title', from: 'Old', to: 'New' },
      { field: 'System.State', from: 'Active', to: 'Resolved' },
      { field: 'System.Tags', from: 'ui', to: '' },
    ]);
    expect(lines.map((l) => l.field)).toEqual(['System.State', 'System.Title', 'Microsoft.VSTS.Common.Priority', 'System.Tags']);
    expect(lines.map((l) => l.kind)).toEqual(['changed', 'changed', 'added', 'removed']);
  });

  it('summarises in one line', () => {
    expect(diffSummary([{ field: 'System.State', from: 'Active', to: 'Resolved' }, { field: 'System.Title', from: 'a', to: 'b' },
      { field: 'X', from: '1', to: '2' }])).toBe('State: Active → Resolved · Title: a → b · +1 more');
    expect(diffSummary([])).toBe('');
  });
});
