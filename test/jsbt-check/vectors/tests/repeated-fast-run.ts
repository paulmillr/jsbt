import { should } from '../../../../src/test.ts';

should('first a', () => {});
should('first b', () => {});
await should.run();

should('second a', () => {});
should('second b', () => {});
await should.run();
