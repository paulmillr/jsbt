import { describe, should } from '../../../../src/test.ts';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('timing', () => {
  should('fast', () => wait(5));
  should('slow', () => wait(30));
  should('medium', () => wait(15));
});

should.runWhen(import.meta.url);
