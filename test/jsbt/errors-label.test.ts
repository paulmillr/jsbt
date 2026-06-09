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

should('errors keeps option-bag labels on the documented callable', async () => {
  const cwd = resolve('test/jsbt/vectors/errors/wrapper-label');
  const res = await capture(() => runCli(['package.json'], { color: false, cwd }));
  deepStrictEqual(res.ok, true);
  deepStrictEqual(
    /wrong opts\.dkLen=false\n- index\.ts:hash: "dkLen" expected number, got boolean/.test(
      res.stdout
    ),
    true
  );
  deepStrictEqual(
    new RegExp(
      'wrong opts\\.personalization=false\\n' +
        '- index\\.ts:hash: "personalization" expected Uint8Array, got type=boolean'
    ).test(res.stdout),
    true
  );
  deepStrictEqual(
    /wrong opts\.onProgress=false\n- index\.ts:hash: "onProgress" expected function, got boolean/.test(
      res.stdout
    ),
    true
  );
  deepStrictEqual(
    /wrong message=false\n- index\.ts:mac: "message" expected Uint8Array, got type=boolean/.test(
      res.stdout
    ),
    true
  );
  deepStrictEqual(/wrong message\.(?:dkLen|personalization)=/.test(res.stdout), false);
});

should.runWhen(import.meta.url);
