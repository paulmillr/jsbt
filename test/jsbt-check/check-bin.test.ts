import { deepStrictEqual, rejects } from 'node:assert';
import { should } from '../../src/test.ts';

// Error offenders and listings paint by ambient TTY; pin machine mode for asserts.
process.env.NO_COLOR = '1';

const { runCli: runCheckBin } = await import('../../src/jsbt-check/check.ts');

const capture = async (fn: () => Promise<void>) => {
  const prev = console.log;
  let out = '';
  console.log = (...args: unknown[]) => {
    out += `${args.join(' ')}\n`;
  };
  try {
    await fn();
  } finally {
    console.log = prev;
  }
  return out;
};

should('jsbt-check prints its own help without jsbt commands', async () => {
  const check = await capture(() => runCheckBin(['--help']));
  deepStrictEqual(/jsbt-check bigint/.test(check), true, check);
  // The size-limits section names baler as the debugging tool, but the baler
  // binary's own usage block (its `baler [--size]` flag line) must never leak here.
  deepStrictEqual(/baler \[--size\]/.test(check), false, check);
  deepStrictEqual(/sizeLimits.*\.jsbtrc\.json/.test(check), true, check);
});

should('jsbt-check rejects removed selectors', async () => {
  await rejects(() => runCheckBin(['check-install']), /unknown check selector: check-install/);
  await rejects(() => runCheckBin(['check-readme']), /unknown check selector: check-readme/);
});

should.runWhen(import.meta.url);
