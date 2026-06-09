import { deepStrictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { dtsPath, exportPath, jsPath, publicEntries, readPkg } from '../../src/jsbt/public.ts';
import { should } from '../../src/test.ts';

should('public path helpers walk nested export condition objects', () => {
  const value = {
    import: { default: './index.mjs' },
    require: './index.cjs',
    types: './index.d.ts',
  };
  deepStrictEqual(jsPath(value), './index.mjs');
  deepStrictEqual(dtsPath(value), './index.d.ts');
});

should('public declaration paths fall back from JS leaves', () => {
  deepStrictEqual(jsPath({ browser: './browser.js' }), './browser.js');
  deepStrictEqual(dtsPath({ node: './node.cjs' }), './node.d.ts');
  deepStrictEqual(dtsPath('./types.d.mts'), './types.d.mts');
});

should('exportPath walks export maps with caller-owned leaf policy', () => {
  const value = {
    import: './esm.mjs',
    node: { default: './node.js' },
    require: './cjs.cjs',
  };
  deepStrictEqual(
    exportPath(value, (path) => (path.endsWith('.js') ? path : '')),
    './node.js'
  );
  deepStrictEqual(
    exportPath(value, (path) => (path.endsWith('.cjs') ? path : '')),
    './cjs.cjs'
  );
});

should('readPkg normalizes export maps and legacy package entries', () => {
  deepStrictEqual(readPkg(resolve('test/jsbt/vectors/check/pass-root/package.json')), {
    exports: { '.': 'index.js' },
    name: '@jsbt-test/check-root',
    self: false,
    types: 'index.d.mts',
  });
  deepStrictEqual(readPkg(resolve('test/jsbt/vectors/jsr/pass-src/package.json')).self, true);
});

should('publicEntries lists sorted public JS export entries with package specs', () => {
  deepStrictEqual(
    publicEntries({
      cwd: '/tmp/pkg',
      pkg: {
        exports: {
          './z': './z.js',
          './types': './types.d.ts',
          '.': { import: './index.js', types: './index.d.ts' },
          './a': { default: './a.mjs' },
          private: './private.js',
        },
        name: '@scope/pkg',
        self: true,
        types: '',
      },
      pkgFile: '/tmp/pkg/package.json',
    }),
    [
      {
        jsRel: './index.js',
        key: '.',
        spec: '@scope/pkg',
        value: { import: './index.js', types: './index.d.ts' },
      },
      { jsRel: './a.mjs', key: './a', spec: '@scope/pkg/a', value: { default: './a.mjs' } },
      { jsRel: './z.js', key: './z', spec: '@scope/pkg/z', value: './z.js' },
    ]
  );
});

should.runWhen(import.meta.url);
