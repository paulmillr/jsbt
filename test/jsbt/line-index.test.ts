import { deepStrictEqual } from 'node:assert';
import { should } from '../../src/test.ts';
import { lineIndex } from '../../src/jsbt/utils.ts';

should('lineIndex maps mixed newline text to lines and offsets', () => {
  const index = lineIndex('first\r\nsecond\nthird');
  deepStrictEqual(index.lines, ['first', 'second', 'third']);
  deepStrictEqual(index.starts, [0, 7, 14]);
  deepStrictEqual(
    [0, 4, 5, 6, 7, 13, 14, 18].map((pos) => index.lineOf(pos)),
    [0, 0, 0, 0, 1, 1, 2, 2]
  );
});

should('lineIndex preserves trailing empty lines', () => {
  const index = lineIndex('a\n');
  deepStrictEqual(index.lines, ['a', '']);
  deepStrictEqual(index.starts, [0, 2]);
  deepStrictEqual(index.lineOf(2), 1);
});

// The local harness only runs registered tests when each standalone file opts in.
should.runWhen(import.meta.url);
