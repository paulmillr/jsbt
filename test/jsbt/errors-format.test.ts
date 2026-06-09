import { deepStrictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { should } from '../../src/test.ts';

process.env.JSBT_LOG_LEVEL = '0';
const { runCli } = await import('../../src/jsbt/errors.ts');

const capture = async (fn: () => Promise<void>) => {
  const prevLog = console.log;
  const prevErr = console.error;
  let stdout = '';
  let stderr = '';
  try {
    console.log = (...args) => {
      stdout += `${args.map((arg) => String(arg)).join(' ')}\n`;
    };
    console.error = (...args) => {
      stderr += `${args.map((arg) => String(arg)).join(' ')}\n`;
    };
    await fn();
    return { ok: true, stderr, stdout };
  } catch (err) {
    stderr += `${err instanceof Error ? err.message : String(err)}\n`;
    return { ok: false, stderr, stdout };
  } finally {
    console.log = prevLog;
    console.error = prevErr;
  }
};

should('errors prints rejected wrong values as an audit table', async () => {
  const cwd = resolve('test/jsbt/vectors/errors/group-format');
  const res = await capture(() => runCli(['package.json'], { color: false, cwd }));
  deepStrictEqual(res, {
    ok: true,
    stderr: '',
    stdout: `wrong msg=false
- index.ts:one: expected Uint8Array, got type=boolean
- index.ts:two: expected Uint8Array, got type=boolean
wrong msg=string
- index.ts:one: expected Uint8Array, got type=string
- index.ts:two: expected Uint8Array, got type=string
wrong msg=array
- index.ts:one: expected Uint8Array, got type=object
- index.ts:two: expected Uint8Array, got type=object
[pass] summary: 2 passed, 0 warnings, 0 failures, 0 skipped
`,
  });
});

should('errors colors audit group headers', async () => {
  const cwd = resolve('test/jsbt/vectors/errors/group-format');
  const res = await capture(() => runCli(['package.json'], { color: true, cwd }));
  deepStrictEqual(res.ok, true);
  deepStrictEqual(/\x1b\[32mwrong msg=false\x1b\[0m\n- index\.ts:one: /.test(res.stdout), true);
});

should('errors does not require generic value labels in expected/got messages', async () => {
  const cwd = resolve('test/jsbt/vectors/errors/value-label');
  const res = await capture(() => runCli(['package.json'], { color: false, cwd }));
  deepStrictEqual(res, {
    ok: true,
    stderr: '',
    stdout: `wrong value=false
- index.ts:check: expected Uint8Array, got type=boolean
wrong value=string
- index.ts:check: expected Uint8Array, got type=string
wrong value=array
- index.ts:check: expected Uint8Array, got type=object
[pass] summary: 1 passed, 0 warnings, 0 failures, 0 skipped
`,
  });
});

should('errors shows accepted probes for wrong runtime types', async () => {
  const cwd = resolve('test/jsbt/vectors/errors/accepted-probes');
  const res = await capture(() => runCli(['package.json'], { color: false, cwd }));
  deepStrictEqual(res, {
    ok: false,
    stderr: `[error] summary: 2 passed, 0 warnings, 6 failures, 0 skipped
Errors check found issues
`,
    stdout: `wrong msg=false
- index.ts:one: NO ERROR!
- index.ts:two: NO ERROR!
wrong msg=string
- index.ts:one: NO ERROR!
- index.ts:two: NO ERROR!
wrong msg=array
- index.ts:one: NO ERROR!
- index.ts:two: NO ERROR!
`,
  });
});

should('errors does not infer nested field contracts for generic object helpers', async () => {
  const cwd = resolve('test/jsbt/vectors/errors/generic-object');
  const res = await capture(() => runCli(['package.json'], { color: false, cwd }));
  deepStrictEqual(res, {
    ok: true,
    stderr: '',
    stdout: `wrong defaults=false
- index.ts:merge: defaults expected object
wrong defaults=null
- index.ts:merge: defaults expected object
wrong defaults=string
- index.ts:merge: defaults expected object
wrong opts=false
- index.ts:merge: opts expected object or undefined
wrong opts=null
- index.ts:merge: opts expected object or undefined
wrong opts=string
- index.ts:merge: opts expected object or undefined
[pass] summary: 1 passed, 0 warnings, 0 failures, 0 skipped
`,
  });
});

should('errors warns before audit when TSDoc examples do not produce probes', async () => {
  const cwd = resolve('test/jsbt/vectors/errors/no-calls');
  const res = await capture(() => runCli(['package.json'], { color: false, cwd }));
  deepStrictEqual(res, {
    ok: true,
    stderr:
      '[WARNING] (errors) src/index.ts:1/example ' +
      'could not derive valid runtime probes from TSDoc example (errors-example)\n' +
      '[warn] summary: 0 passed, 1 warning, 0 failures, 0 skipped\n',
    stdout: '',
  });
});

should('errors does not warn for zero-argument owners without probes', async () => {
  const cwd = resolve('test/jsbt/vectors/errors/zero-arg-no-warning');
  const res = await capture(() => runCli(['package.json'], { color: false, cwd }));
  deepStrictEqual(res, {
    ok: true,
    stderr: '',
    stdout: '[pass] summary: 0 passed, 0 warnings, 0 failures, 0 skipped\n',
  });
});

should('errors does not probe optional internal error label parameters', async () => {
  const cwd = resolve('test/jsbt/vectors/errors/label-param');
  const res = await capture(() => runCli(['package.json'], { color: false, cwd }));
  deepStrictEqual(res, {
    ok: true,
    stderr: '',
    stdout: `wrong data=false
- index.ts:normalize: expected Uint8Array, got type=boolean
wrong data=string
- index.ts:normalize: expected Uint8Array, got type=string
wrong data=array
- index.ts:normalize: expected Uint8Array, got type=object
[pass] summary: 1 passed, 0 warnings, 0 failures, 0 skipped
`,
  });
});

should(
  'errors skips underscore-private files, symbols, classes, methods, and arguments',
  async () => {
    const cwd = resolve('test/jsbt/vectors/errors/private-skip');
    const res = await capture(() => runCli(['package.json'], { color: false, cwd }));
    deepStrictEqual(res, {
      ok: true,
      stderr: '',
      stdout: `wrong data=false
- index.ts:publicFn     : data expected Uint8Array
- index.ts:secretFactory: data expected Uint8Array
- index.ts:box.open     : data expected Uint8Array
wrong data=string
- index.ts:publicFn     : data expected Uint8Array
- index.ts:secretFactory: data expected Uint8Array
- index.ts:box.open     : data expected Uint8Array
wrong data=array
- index.ts:publicFn     : data expected Uint8Array
- index.ts:secretFactory: data expected Uint8Array
- index.ts:box.open     : data expected Uint8Array
[pass] summary: 4 passed, 0 warnings, 0 failures, 0 skipped
`,
    });
  }
);

should('errors inspects objects returned from public function-valued properties', async () => {
  const cwd = resolve('test/jsbt/vectors/errors/function-output');
  const res = await capture(() => runCli(['package.json'], { color: false, cwd }));
  deepStrictEqual(res, {
    ok: true,
    stderr: '',
    stdout: `wrong message=false
- index.ts:wrapper             : message expected Uint8Array
- index.ts:wrapper.state.update: message expected Uint8Array
wrong message=string
- index.ts:wrapper             : message expected Uint8Array
- index.ts:wrapper.state.update: message expected Uint8Array
wrong message=array
- index.ts:wrapper             : message expected Uint8Array
- index.ts:wrapper.state.update: message expected Uint8Array
wrong message=object
- index.ts:wrapper.state.update: message expected Uint8Array
wrong message=null
- index.ts:wrapper.state.update: message expected Uint8Array
wrong dst=false
- index.ts:wrapper.state.digestInto: dst expected Uint8Array
wrong dst=string
- index.ts:wrapper.state.digestInto: dst expected Uint8Array
wrong dst=object
- index.ts:wrapper.state.digestInto: dst expected Uint8Array
wrong dst=array
- index.ts:wrapper.state.digestInto: dst expected Uint8Array
wrong dst=null
- index.ts:wrapper.state.digestInto: dst expected Uint8Array
[pass] summary: 3 passed, 0 warnings, 0 failures, 0 skipped
`,
  });
});

should.runWhen(import.meta.url);
