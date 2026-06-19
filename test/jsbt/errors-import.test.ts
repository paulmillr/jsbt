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
      const line = args.map((arg) => String(arg)).join(' ');
      if (/^(?:write|delete)\t.*\/\.__errors-check-/.test(line)) return;
      stdout += `${line}\n`;
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

should('errors handles examples with default-only package imports', async () => {
  const cwd = resolve('test/jsbt/vectors/errors/default-import');
  const res = await capture(() => runCli(['package.json'], { color: false, cwd }));
  deepStrictEqual(res, {
    ok: true,
    stderr: '',
    stdout: `wrong value=false
- index.ts:verify: expected value, got boolean
wrong value=1
- index.ts:verify: expected value, got number
wrong value=object
- index.ts:verify: expected value, got object
[pass] summary: 1 passed, 0 warnings, 0 failures, 0 skipped
`,
  });
});

should.runWhen(import.meta.url);
