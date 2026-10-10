import vectors from '../../../../../specs/014-task-board/vectors/acceptance-items.json';
import { acceptanceItems, itemKey } from './acceptance-items';

describe('acceptanceItems (shared vectors with AcceptanceItems.java)', () => {
  for (const v of vectors.vectors) {
    it(v.name, () => expect(acceptanceItems(v.text)).toEqual(v.items));
  }

  for (const [a, b] of vectors.keySame) {
    it(`gives '${a}' and '${b}' the same key`, async () => expect(await itemKey(a)).toBe(await itemKey(b)));
  }

  for (const [a, b] of vectors.keyDiffer) {
    it(`gives '${a}' and '${b}' different keys`, async () => expect(await itemKey(a)).not.toBe(await itemKey(b)));
  }
});
