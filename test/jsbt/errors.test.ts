import { deepStrictEqual } from 'node:assert';
import { join, resolve } from 'node:path';
import { should } from '../../src/test.ts';

const ROOT = resolve('test/jsbt/vectors/errors');
process.env.JSBT_LOG_LEVEL = '0';
const { runCli: runErrors } = await import('../../src/jsbt/errors.ts');
const { runCli: runJsbt } = await import('../../src/jsbt/index.ts');

const fixture = (name: string) => join(ROOT, name);
const capture = async (fn: () => Promise<void>) => {
  const prevLog = console.log;
  const prevErr = console.error;
  const seq: string[] = [];
  let stdout = '';
  let stderr = '';
  console.log = (...args) => {
    const line = args.map((arg) => String(arg)).join(' ');
    stdout += `${line}\n`;
    seq.push(line);
  };
  console.error = (...args) => {
    const line = args.map((arg) => String(arg)).join(' ');
    stderr += `${line}\n`;
    seq.push(line);
  };
  try {
    await fn();
    return { error: undefined, ok: true, seq, stderr, stdout };
  } catch (error) {
    const line = (error as Error).message;
    stderr += `${line}\n`;
    seq.push(line);
    return { error: error as Error, ok: false, seq, stderr, stdout };
  } finally {
    console.log = prevLog;
    console.error = prevErr;
  }
};
const all = (res: { stderr: string; stdout: string }) =>
  [res.stdout, res.stderr].filter(Boolean).join('\n');
const plain = (res: { stderr: string; stdout: string }) =>
  all(res).replace(/\x1b\[\d+(;\d+)*m/g, '');

should('errors passes when examples reject wrong runtime types and return copies', async () => {
  const cwd = fixture('pass');
  const res = await capture(() => runErrors(['package.json'], { color: false, cwd }));
  deepStrictEqual(res.ok, true);
  deepStrictEqual(/summary: 15 passed, 0 warnings, 0 failures, 0 skipped/.test(plain(res)), true);
});

should(
  'errors reports accepted wrong types, rejected-value audit, mutation, and aliasing',
  async () => {
    const cwd = fixture('fail');
    const res = await capture(() => runErrors(['package.json'], { color: false, cwd }));
    const out = plain(res);
    deepStrictEqual(res.ok, false);
    deepStrictEqual(
      /wrong secretKey=false\n- index\.ts:isValidSecretKey: NO ERROR!/.test(out),
      true
    );
    deepStrictEqual(/- index\.ts:vague\s+: bad/.test(out), true);
    deepStrictEqual(
      /wrong msg=null\n- index\.ts:badReturnedCoder\.encode: NO ERROR!/.test(out),
      true
    );
    deepStrictEqual(
      new RegExp(
        '\\[WARN\\] errors: src/index\\.ts:\\d+/mutates ' +
          'valid call mutates input at arg\\[0\\]; ' +
          'document explicit mutation or copy input \\(errors-mutation\\)'
      ).test(out),
      true
    );
    deepStrictEqual(
      new RegExp(
        '\\[WARN\\] errors: src/index\\.ts:\\d+/aliases ' +
          'return value aliases input; ' +
          'document returned-input aliasing or copy output \\(errors-alias\\)'
      ).test(out),
      true
    );
    deepStrictEqual(/summary: 4 passed, 2 warnings, 8 failures, 0 skipped/.test(out), true);
    deepStrictEqual(/Errors check found issues/.test(out), true);
  }
);

should('check errors selector runs the standalone errors checker', async () => {
  const cwd = fixture('fail');
  const res = await capture(() => runJsbt(['check', 'errors'], { color: false, cwd }));
  const out = plain(res);
  deepStrictEqual(res.ok, false);
  deepStrictEqual(/wrong secretKey=false/.test(out), true);
  deepStrictEqual(/- index\.ts:isValidSecretKey: NO ERROR!/.test(out), true);
  deepStrictEqual(/unknown:0 Errors check found issues/.test(out), false);
  deepStrictEqual(/1 check finished in \d+ sec/.test(out), true);
});

should('check errors selector reports unprobeable examples before audit rows', async () => {
  const cwd = fixture('mixed-no-calls');
  const res = await capture(() => runJsbt(['check', 'errors'], { color: false, cwd }));
  const out = plain(res);
  deepStrictEqual(res.ok, false);
  deepStrictEqual(
    /could not derive valid runtime probes from TSDoc example[\s\S]*wrong bytesLength=true/.test(
      res.seq.join('\n')
    ),
    true
  );
  deepStrictEqual(
    /wrong bytesLength=true\n- index\.ts:randomBytes: "bytesLength" expected number, got boolean/.test(
      out
    ),
    true
  );
  deepStrictEqual(/wrong 32=/.test(out), false);
});

should('errors keeps runtime probes isolated per example', async () => {
  const cwd = fixture('state-isolation');
  const res = await capture(() => runErrors(['package.json'], { color: false, cwd, limit: 1 }));
  const out = plain(res);
  deepStrictEqual(res.ok, true, out);
  deepStrictEqual(/state leaked/.test(out), false);
  deepStrictEqual(/summary: \d+ passed, 0 warnings, 0 failures, 0 skipped/.test(out), true);
});

should('errors keeps timeout failures scoped to the hung example', async () => {
  const cwd = fixture('timeout-isolation');
  const res = await capture(() =>
    runErrors(['package.json'], { color: false, cwd, limit: 1, timeoutMs: 200 })
  );
  const out = plain(res);
  deepStrictEqual(res.ok, true, out);
  deepStrictEqual((out.match(/timed out after 200ms/g) || []).length, 1, out);
  deepStrictEqual(/summary: \d+ passed, 1 warning, 0 failures, 0 skipped/.test(out), true);
});

should.runWhen(import.meta.url);
