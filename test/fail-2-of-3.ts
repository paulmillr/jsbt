import { should } from '../src/test.ts';
should('2 + 2', () => {
  throw new Error('1');
});
should('2 + 3', () => {
  throw new Error('2');
});
should('2 + 4', () => {});
should.run();
