import { should } from '../src/test.ts';
should('2 + 2', () => {});
should('2 + 3', () => {});
should.opts.QUIET = true;
should.opts.FAST = 1;
should.run();
