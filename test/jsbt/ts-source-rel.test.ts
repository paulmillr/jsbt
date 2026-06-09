import { deepStrictEqual } from 'node:assert';
import { should } from '../../src/test.ts';
import { tsSourceRel } from '../../src/jsbt/utils.ts';

should('tsSourceRel normalizes public JS and declaration paths to TS source rels', () => {
  deepStrictEqual(tsSourceRel('./index.js'), 'index.ts');
  deepStrictEqual(tsSourceRel('./mod.mjs'), 'mod.ts');
  deepStrictEqual(tsSourceRel('./old.cjs'), 'old.ts');
  deepStrictEqual(tsSourceRel('./index.d.ts'), 'index.ts');
  deepStrictEqual(tsSourceRel('./mod.d.mts'), 'mod.ts');
  deepStrictEqual(tsSourceRel('src/index.d.cts'), 'src/index.ts');
});

should.runWhen(import.meta.url);
