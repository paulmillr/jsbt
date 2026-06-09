import { deepStrictEqual, doesNotMatch, match } from 'node:assert';
import { resolve } from 'node:path';
import { should } from '../../src/test.ts';

process.env.JSBT_LOG_LEVEL = '0';
const { runCli } = await import('../../src/jsbt/errors.ts');

const rx = (parts: string[]): RegExp => new RegExp(parts.join(''));
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

should('errors probes documented public object method examples with method labels', async () => {
  const cwd = resolve('test/jsbt/vectors/errors/object-methods');
  const res = await capture(() => runCli(['package.json'], { color: false, cwd }));
  deepStrictEqual(res.ok, true);
  match(
    res.stdout,
    /wrong seed=false\n- index\.ts:suite\.keygen\s+: "seed" expected Uint8Array, got type=boolean/
  );
  match(
    res.stdout,
    /wrong msg=false[\s\S]*- index\.ts:suite\.sign\s+: "msg" expected Uint8Array, got type=boolean/
  );
  match(
    res.stdout,
    rx([
      'wrong sig=false[\\s\\S]*',
      '- index\\.ts:suite\\.verify\\s+: ',
      '"sig" expected Uint8Array, got type=boolean',
    ])
  );
  match(
    res.stdout,
    rx([
      'wrong secretKey=false[\\s\\S]*',
      '- index\\.ts:suite\\.getPublicKey\\s+: ',
      '"secretKey" expected Uint8Array, got type=boolean',
    ])
  );
  match(
    res.stdout,
    rx([
      'wrong secretKey=false[\\s\\S]*',
      '- index\\.ts:suite\\.utils\\.isValidSecretKey\\s+: ',
      '"secretKey" expected Uint8Array, got type=boolean',
    ])
  );
  doesNotMatch(res.stdout, /wrong arg\d+=/);
  doesNotMatch(res.stderr, /could not derive valid runtime probes/);
});

should('errors labels dynamically discovered returned methods from method docs', async () => {
  const cwd = resolve('test/jsbt/vectors/errors/object-methods');
  const res = await capture(() => runCli(['package.json'], { color: false, cwd }));
  deepStrictEqual(res.ok, true);
  match(
    res.stdout,
    rx([
      'wrong plaintext=false[\\s\\S]*',
      '- index\\.ts:makeBox\\.encrypt: ',
      '"plaintext" expected Uint8Array, got type=boolean',
    ])
  );
  match(
    res.stdout,
    rx([
      'wrong ciphertext=false[\\s\\S]*',
      '- index\\.ts:makeBox\\.decrypt: ',
      '"ciphertext" expected Uint8Array, got type=boolean',
    ])
  );
  match(
    res.stdout,
    rx([
      'wrong output=false[\\s\\S]*',
      '- index\\.ts:box\\.encrypt\\s+: ',
      '"output" expected Uint8Array, got type=boolean',
    ])
  );
  doesNotMatch(res.stdout, /wrong arg\d+=/);
});

should('errors replays chain self expressions before probing consuming methods', async () => {
  const cwd = resolve('test/jsbt/vectors/errors/object-methods');
  const res = await capture(() => runCli(['package.json'], { color: false, cwd }));
  deepStrictEqual(res.ok, true);
  match(
    res.stdout,
    rx([
      'wrong output=false[\\s\\S]*',
      '- index\\.ts:makeChain\\.update\\.digestInto\\s*: ',
      '"output" expected Uint8Array, got type=boolean',
    ])
  );
  doesNotMatch(res.stdout, /chain has been destroyed/);
  doesNotMatch(res.stdout, /makeChain\(key\)\.update/);
});

should('errors reuses example args when probing returned suite methods', async () => {
  const cwd = resolve('test/jsbt/vectors/errors/object-methods');
  const res = await capture(() => runCli(['package.json'], { color: false, cwd }));
  deepStrictEqual(res.ok, true);
  match(
    res.stdout,
    rx([
      'wrong msg=false[\\s\\S]*',
      '- index\\.ts:makeReturnedSuite\\.sign\\s*: ',
      '"msg" expected Uint8Array, got type=boolean',
    ])
  );
  match(
    res.stdout,
    rx([
      'wrong sig=false[\\s\\S]*',
      '- index\\.ts:makeReturnedSuite\\.verify\\s*: ',
      '"sig" expected Uint8Array, got type=boolean',
    ])
  );
  match(
    res.stdout,
    rx([
      'wrong publicKey=false[\\s\\S]*',
      '- index\\.ts:makeReturnedSuite\\.verify\\s*: ',
      '"publicKey" expected Uint8Array, got type=boolean',
    ])
  );
  doesNotMatch(res.stdout, /makeReturnedSuite\.(?:sign|verify)[^\n]+undefined/);
});

should('errors derives sibling returned-suite args from keygen and sign methods', async () => {
  const cwd = resolve('test/jsbt/vectors/errors/object-methods');
  const res = await capture(() => runCli(['package.json'], { color: false, cwd }));
  deepStrictEqual(res.ok, true);
  match(
    res.stdout,
    rx([
      'wrong sig=false[\\s\\S]*',
      '- index\\.ts:makeRegistry\\.short\\.verify\\s*: ',
      '"sig" expected Uint8Array, got type=boolean',
    ])
  );
  match(
    res.stdout,
    rx([
      'wrong publicKey=false[\\s\\S]*',
      '- index\\.ts:makeRegistry\\.short\\.verify\\s*: ',
      '"publicKey" expected Uint8Array, got type=boolean',
    ])
  );
  doesNotMatch(res.stdout, /makeRegistry\.(?:long|short)\.verify[^\n]+undefined/);
});

should('errors derives hashed signer args without optional runtime guard noise', async () => {
  const cwd = resolve('test/jsbt/vectors/errors/object-methods');
  const res = await capture(() => runCli(['package.json'], { color: false, cwd }));
  deepStrictEqual(res.ok, true);
  match(
    res.stdout,
    rx([
      'wrong publicKey=false[\\s\\S]*',
      '- index\\.ts:makeHashedRegistry\\.long\\.verify\\s*: ',
      '"publicKey" expected public key',
    ])
  );
  match(
    res.stdout,
    rx([
      'wrong publicKey=false[\\s\\S]*',
      '- index\\.ts:makeHashedRegistry\\.short\\.verify\\s*: ',
      '"publicKey" expected public key',
    ])
  );
  match(
    res.stdout,
    rx([
      'wrong publicKey=false[\\s\\S]*',
      '- index\\.ts:registry\\.long\\.verify\\s*: ',
      '"publicKey" expected public key',
    ])
  );
  match(
    res.stdout,
    rx([
      'wrong signature=false[\\s\\S]*',
      '- index\\.ts:makeHashedRegistry\\.short\\.verify\\s*: ',
      '"signature" expected signature',
    ])
  );
  doesNotMatch(res.stdout, /wrong unusedArg=/);
  doesNotMatch(res.stdout, /makeHashedRegistry\.(?:long|short)\.(?:sign|verify)[^\n]+undefined/);
});

should.runWhen(import.meta.url);
