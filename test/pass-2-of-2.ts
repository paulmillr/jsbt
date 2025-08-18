import { should } from '../src/test.ts';
should('2 + 2', () => {});
should('2 + 3', () => {});
should.opts.QUIET = false;
should.opts.FAST = false;
should.run();
