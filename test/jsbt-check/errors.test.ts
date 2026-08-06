import { deepStrictEqual } from 'node:assert';
import { should } from '../../src/test.ts';
import { errorsVector as fixture } from './errors-vectors.ts';

process.env.JSBT_LOG_LEVEL = '0';
const { runCli: runErrors } = await import('../../src/jsbt-check/errors.ts');
const { runCli: runCheckBin } = await import('../../src/jsbt-check/check.ts');
// Legacy shim over the split binaries: strips the old `check` command head.
const runJsbt = (argv: string[], opts: Record<string, unknown> = {}) =>
  runCheckBin(argv[0] === 'check' ? argv.slice(1) : argv, opts);

const rx = (parts: string[]): RegExp => new RegExp(parts.join(''));
const capture = async (fn: () => Promise<void>) => {
  const prevLog = console.log;
  const prevErr = console.error;
  const seq: string[] = [];
  let stdout = '';
  let stderr = '';
  console.log = (...args) => {
    const line = args.map((arg) => String(arg)).join(' ');
    if (/^(?:write|delete)\t.*\/\.__errors-check-/.test(line)) return;
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
const out = (res: { ok: boolean; stderr: string; stdout: string }) => ({
  ok: res.ok,
  stderr: res.stderr,
  stdout: res.stdout,
});
const all = (res: { stderr: string; stdout: string }) =>
  [res.stdout, res.stderr].filter(Boolean).join('\n');
const plain = (res: { stderr: string; stdout: string }) =>
  all(res).replace(/\x1b\[\d+(;\d+)*m/g, '');
const withEnv = async <T>(key: string, value: string, fn: () => Promise<T>) => {
  const prev = process.env[key];
  process.env[key] = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
};

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
  const res = await withEnv('JSBT_QUIET', '', () =>
    capture(() => runJsbt(['check', 'errors'], { color: false, cwd }))
  );
  const out = plain(res);
  deepStrictEqual(res.ok, true);
  deepStrictEqual(/wrong secretKey=false/.test(out), true);
  deepStrictEqual(/- index\.ts:isValidSecretKey: NO ERROR!/.test(out), true);
  deepStrictEqual(/unknown:0 Errors check found issues/.test(out), false);
  deepStrictEqual(/1 check finished in \d+ sec/.test(out), true);
});

should('check errors selector reports unprobeable examples before audit rows', async () => {
  const cwd = fixture('mixed-no-calls');
  const res = await withEnv('JSBT_QUIET', '', () =>
    capture(() => runJsbt(['check', 'errors'], { color: false, cwd }))
  );
  const out = plain(res);
  deepStrictEqual(res.ok, true);
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

should('errors prints rejected wrong values as an audit table', async () => {
  const cwd = fixture('group-format');
  const res = await capture(() => runErrors(['package.json'], { color: false, cwd }));
  deepStrictEqual(out(res), {
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
  const cwd = fixture('group-format');
  const res = await capture(() => runErrors(['package.json'], { color: true, cwd }));
  deepStrictEqual(res.ok, true);
  deepStrictEqual(/\x1b\[32mwrong msg=false\x1b\[0m\n- index\.ts:one: /.test(res.stdout), true);
});

should('errors does not require generic value labels in expected/got messages', async () => {
  const cwd = fixture('value-label');
  const res = await capture(() => runErrors(['package.json'], { color: false, cwd }));
  deepStrictEqual(out(res), {
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
  const cwd = fixture('accepted-probes');
  const res = await capture(() => runErrors(['package.json'], { color: false, cwd }));
  deepStrictEqual(out(res), {
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
  const cwd = fixture('generic-object');
  const res = await capture(() => runErrors(['package.json'], { color: false, cwd }));
  deepStrictEqual(out(res), {
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
  const cwd = fixture('no-calls');
  const res = await capture(() => runErrors(['package.json'], { color: false, cwd }));
  deepStrictEqual(out(res), {
    ok: true,
    stderr:
      '[WARN] errors: src/index.ts:1/example ' +
      'could not derive valid runtime probes from TSDoc example (errors-example)\n' +
      '[warn] summary: 0 passed, 1 warning, 0 failures, 0 skipped\n',
    stdout: '',
  });
});

should('errors does not warn for zero-argument owners without probes', async () => {
  const cwd = fixture('zero-arg-no-warning');
  const res = await capture(() => runErrors(['package.json'], { color: false, cwd }));
  deepStrictEqual(out(res), {
    ok: true,
    stderr: '',
    stdout: '[pass] summary: 0 passed, 0 warnings, 0 failures, 0 skipped\n',
  });
});

should('errors does not probe optional internal error label parameters', async () => {
  const cwd = fixture('label-param');
  const res = await capture(() => runErrors(['package.json'], { color: false, cwd }));
  deepStrictEqual(out(res), {
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
    const cwd = fixture('private-skip');
    const res = await capture(() => runErrors(['package.json'], { color: false, cwd }));
    deepStrictEqual(out(res), {
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
  const cwd = fixture('function-output');
  const res = await capture(() => runErrors(['package.json'], { color: false, cwd }));
  deepStrictEqual(out(res), {
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

should('errors handles examples with default-only package imports', async () => {
  const cwd = fixture('default-import');
  const res = await capture(() => runErrors(['package.json'], { color: false, cwd }));
  deepStrictEqual(out(res), {
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

should('errors keeps option-bag labels on the documented callable', async () => {
  const cwd = fixture('wrapper-label');
  const res = await capture(() => runErrors(['package.json'], { color: false, cwd }));
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

should('errors ignores Promise chain methods in examples', async () => {
  const cwd = fixture('promise-chain');
  const res = await capture(() => runErrors(['package.json'], { color: false, cwd }));
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

should('errors probes documented public object method examples with method labels', async () => {
  const cwd = fixture('object-methods');
  const res = await capture(() => runErrors(['package.json'], { color: false, cwd }));
  deepStrictEqual(res.ok, true);
  deepStrictEqual(
    /wrong seed=false\n- index\.ts:suite\.keygen\s+: "seed" expected Uint8Array, got type=boolean/.test(
      res.stdout
    ),
    true
  );
  deepStrictEqual(
    /wrong msg=false[\s\S]*- index\.ts:suite\.sign\s+: "msg" expected Uint8Array, got type=boolean/.test(
      res.stdout
    ),
    true
  );
  deepStrictEqual(
    rx([
      'wrong sig=false[\\s\\S]*',
      '- index\\.ts:suite\\.verify\\s+: ',
      '"sig" expected Uint8Array, got type=boolean',
    ]).test(res.stdout),
    true
  );
  deepStrictEqual(
    rx([
      'wrong secretKey=false[\\s\\S]*',
      '- index\\.ts:suite\\.getPublicKey\\s+: ',
      '"secretKey" expected Uint8Array, got type=boolean',
    ]).test(res.stdout),
    true
  );
  deepStrictEqual(
    rx([
      'wrong secretKey=false[\\s\\S]*',
      '- index\\.ts:suite\\.utils\\.isValidSecretKey\\s+: ',
      '"secretKey" expected Uint8Array, got type=boolean',
    ]).test(res.stdout),
    true
  );
  deepStrictEqual(/wrong arg\d+=/.test(res.stdout), false);
  deepStrictEqual(/could not derive valid runtime probes/.test(res.stderr), false);
});

should('errors labels dynamically discovered returned methods from method docs', async () => {
  const cwd = fixture('object-methods');
  const res = await capture(() => runErrors(['package.json'], { color: false, cwd }));
  deepStrictEqual(res.ok, true);
  deepStrictEqual(
    rx([
      'wrong plaintext=false[\\s\\S]*',
      '- index\\.ts:makeBox\\.encrypt: ',
      '"plaintext" expected Uint8Array, got type=boolean',
    ]).test(res.stdout),
    true
  );
  deepStrictEqual(
    rx([
      'wrong ciphertext=false[\\s\\S]*',
      '- index\\.ts:makeBox\\.decrypt: ',
      '"ciphertext" expected Uint8Array, got type=boolean',
    ]).test(res.stdout),
    true
  );
  deepStrictEqual(
    rx([
      'wrong output=false[\\s\\S]*',
      '- index\\.ts:box\\.encrypt\\s+: ',
      '"output" expected Uint8Array, got type=boolean',
    ]).test(res.stdout),
    true
  );
  deepStrictEqual(/wrong arg\d+=/.test(res.stdout), false);
});

should('errors replays chain self expressions before probing consuming methods', async () => {
  const cwd = fixture('object-methods');
  const res = await capture(() => runErrors(['package.json'], { color: false, cwd }));
  deepStrictEqual(res.ok, true);
  deepStrictEqual(
    rx([
      'wrong output=false[\\s\\S]*',
      '- index\\.ts:makeChain\\.update\\.digestInto\\s*: ',
      '"output" expected Uint8Array, got type=boolean',
    ]).test(res.stdout),
    true
  );
  deepStrictEqual(/chain has been destroyed/.test(res.stdout), false);
  deepStrictEqual(/makeChain\(key\)\.update/.test(res.stdout), false);
});

should('errors reuses example args when probing returned suite methods', async () => {
  const cwd = fixture('object-methods');
  const res = await capture(() => runErrors(['package.json'], { color: false, cwd }));
  deepStrictEqual(res.ok, true);
  deepStrictEqual(
    rx([
      'wrong msg=false[\\s\\S]*',
      '- index\\.ts:makeReturnedSuite\\.sign\\s*: ',
      '"msg" expected Uint8Array, got type=boolean',
    ]).test(res.stdout),
    true
  );
  deepStrictEqual(
    rx([
      'wrong sig=false[\\s\\S]*',
      '- index\\.ts:makeReturnedSuite\\.verify\\s*: ',
      '"sig" expected Uint8Array, got type=boolean',
    ]).test(res.stdout),
    true
  );
  deepStrictEqual(
    rx([
      'wrong publicKey=false[\\s\\S]*',
      '- index\\.ts:makeReturnedSuite\\.verify\\s*: ',
      '"publicKey" expected Uint8Array, got type=boolean',
    ]).test(res.stdout),
    true
  );
  deepStrictEqual(/makeReturnedSuite\.(?:sign|verify)[^\n]+undefined/.test(res.stdout), false);
});

should('errors derives sibling returned-suite args from keygen and sign methods', async () => {
  const cwd = fixture('object-methods');
  const res = await capture(() => runErrors(['package.json'], { color: false, cwd }));
  deepStrictEqual(res.ok, true);
  deepStrictEqual(
    rx([
      'wrong sig=false[\\s\\S]*',
      '- index\\.ts:makeRegistry\\.short\\.verify\\s*: ',
      '"sig" expected Uint8Array, got type=boolean',
    ]).test(res.stdout),
    true
  );
  deepStrictEqual(
    rx([
      'wrong publicKey=false[\\s\\S]*',
      '- index\\.ts:makeRegistry\\.short\\.verify\\s*: ',
      '"publicKey" expected Uint8Array, got type=boolean',
    ]).test(res.stdout),
    true
  );
  deepStrictEqual(/makeRegistry\.(?:long|short)\.verify[^\n]+undefined/.test(res.stdout), false);
});

should('errors derives hashed signer args without optional runtime guard noise', async () => {
  const cwd = fixture('object-methods');
  const res = await capture(() => runErrors(['package.json'], { color: false, cwd }));
  deepStrictEqual(res.ok, true);
  deepStrictEqual(
    rx([
      'wrong publicKey=false[\\s\\S]*',
      '- index\\.ts:makeHashedRegistry\\.long\\.verify\\s*: ',
      '"publicKey" expected public key',
    ]).test(res.stdout),
    true
  );
  deepStrictEqual(
    rx([
      'wrong publicKey=false[\\s\\S]*',
      '- index\\.ts:makeHashedRegistry\\.short\\.verify\\s*: ',
      '"publicKey" expected public key',
    ]).test(res.stdout),
    true
  );
  deepStrictEqual(
    rx([
      'wrong publicKey=false[\\s\\S]*',
      '- index\\.ts:registry\\.long\\.verify\\s*: ',
      '"publicKey" expected public key',
    ]).test(res.stdout),
    true
  );
  deepStrictEqual(
    rx([
      'wrong signature=false[\\s\\S]*',
      '- index\\.ts:makeHashedRegistry\\.short\\.verify\\s*: ',
      '"signature" expected signature',
    ]).test(res.stdout),
    true
  );
  deepStrictEqual(/wrong unusedArg=/.test(res.stdout), false);
  deepStrictEqual(
    /makeHashedRegistry\.(?:long|short)\.(?:sign|verify)[^\n]+undefined/.test(res.stdout),
    false
  );
});

should.runWhen(import.meta.url);
