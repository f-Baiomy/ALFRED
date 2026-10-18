import { boardRefChip, plainBoardTitle } from './board-title';

describe('board-title', () => {
  it('drops the work item prefix the ref chip already shows', () => {
    expect(plainBoardTitle('#59851_Q4-INTE-CORE-015 Baggage Bundle Choice Display & Ancillary Clarification "Air Arabia"'))
      .toBe('Baggage Bundle Choice Display & Ancillary Clarification "Air Arabia"');
    expect(plainBoardTitle('#61813_ Seat map refresh')).toBe('Seat map refresh');
    expect(plainBoardTitle('AB#61813 · Seat map refresh', 'AB#61813')).toBe('Seat map refresh');
    expect(plainBoardTitle('Login lockout')).toBe('Login lockout');
  });

  it('never leaves an empty title', () => {
    expect(plainBoardTitle('#59851_')).toBe('#59851_');
    expect(plainBoardTitle(null)).toBe('');
  });

  it('shows a chip only for a work item', () => {
    expect(boardRefChip('AB#59851', null)).toBe('AB#59851');
    expect(boardRefChip('Login lockout', 'azure/61813')).toBe('AB#61813');
    expect(boardRefChip('Login lockout', null)).toBeNull();
  });
});
