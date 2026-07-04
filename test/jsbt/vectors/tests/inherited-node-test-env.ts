import { deepStrictEqual } from 'node:assert';
import { should } from '../../../../src/test.ts';

should.opts.FAST = 0;

should('uses custom runner without node --test exec args', () => {
  deepStrictEqual(process.env.NODE_TEST_CONTEXT, 'child-v8');
});

await should.run();
