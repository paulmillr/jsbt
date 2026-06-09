import { deepStrictEqual } from 'node:assert';
import { should } from '../../src/test.ts';
import { camelParts } from '../../src/jsbt/utils.ts';

should('camelParts joins pre-tokenized name parts', () => {
  deepStrictEqual(camelParts(['noble', 'curves']), 'nobleCurves');
  deepStrictEqual(camelParts(['namespace', 'ab', 'cd']), 'namespaceAbCd');
  deepStrictEqual(camelParts(['single']), 'single');
});

should.runWhen(import.meta.url);
