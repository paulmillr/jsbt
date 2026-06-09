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

should('errors ignores Promise chain methods in examples', async () => {
  const cwd = resolve('test/jsbt/vectors/errors/promise-chain');
  const res = await capture(() => runCli(['package.json'], { color: false, cwd }));
  deepStrictEqual(res.ok, true);
  deepStrictEqual(
    new RegExp(
      'wrong privateKey=false\\n' +
        '- index\\.ts:parsePrivateKey: "privateKey" expected string, got type=boolean'
    ).test(res.stdout),
    true
  );
  deepStrictEqual(
    /wrong text=false\n- index\.ts:parsePackets: "text" expected string, got type=boolean/.test(
      res.stdout
    ),
    true
  );
  deepStrictEqual(/example probe failed/.test(res.stderr), false);
  deepStrictEqual(/\.then/.test(res.stdout), false);
  deepStrictEqual(/\.find/.test(res.stdout), false);
  deepStrictEqual(/wrong arg0=/.test(res.stdout), false);
});

should.runWhen(import.meta.url);
