import vectors from '../../../../../specs/014-task-board/vectors/quick-add.json';
import { parseQuickAdd } from './quick-add-parser';

describe('parseQuickAdd (shared vectors with QuickAddParser.java)', () => {
  for (const v of vectors.vectors) {
    it(`reads '${v.line}'`, () => {
      const parsed = parseQuickAdd(v.line);
      expect(parsed.kind).toBe(v.kind as typeof parsed.kind);
      expect(parsed.title).toBe(v.title);
      expect([...parsed.flags].sort()).toEqual([...v.flags].sort() as typeof parsed.flags[number][]);
    });
  }
});
