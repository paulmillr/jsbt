import { deepStrictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { should } from '../../src/test.ts';
import { dirEntries } from '../../src/jsbt/utils.ts';

should('dirEntries returns directory entries sorted by name', () => {
  const dir = resolve('test/jsbt/vectors/check/fail-src/src');
  deepStrictEqual(
    dirEntries(dir).map((ent) => ent.name),
    [
      'alpha.d.mts',
      'alpha.js',
      'alpha.ts',
      'broken.d.mts',
      'broken.js',
      'broken.ts',
      'dupe.ts',
      'index.d.mts',
      'index.js',
      'index.ts',
      'note.ts',
    ]
  );
});

should.runWhen(import.meta.url);
