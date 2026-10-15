import { adviceButton } from './board-card.component';

describe('adviceButton (specs/020)', () => {
  it('maps Claude\'s advised option to the sort button it outlines; a merge has none', () => {
    expect(adviceButton('To do')).toBe('TO_DO');
    expect(adviceButton('Fine')).toBe('FINE');
    expect(adviceButton('Not in this flow')).toBe('NOT_IN_FLOW');
    expect(adviceButton('Not in flow')).toBe('NOT_IN_FLOW');
    expect(adviceButton('Merge into #44')).toBeNull();
    expect(adviceButton(null)).toBeNull();
  });
});
