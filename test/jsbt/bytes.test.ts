import { deepStrictEqual } from 'node:assert';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { should } from '../../src/test.ts';

const ROOT = resolve('test/jsbt/vectors/bytes');
const BUILD = resolve('test/jsbt/build/bytes-boundary');
const POLARITY = resolve('test/jsbt/vectors/bytes-polarity');
const POLARITY_BUILD = resolve('test/jsbt/build/bytes-polarity');
const { runCli: runJsbt } = await import('../../src/jsbt/index.ts');
const { runCli: runBytes } = await import('../../src/jsbt/bytes.ts');
const ts = await import('typescript');
type Ver = '5.6.3' | '6.0.2';

const capture = async (fn: () => Promise<void>) => {
  const prevLog = console.log;
  const prevErr = console.error;
  let stdout = '';
  let stderr = '';
  console.log = (...args) => {
    stdout += `${args.map((arg) => String(arg)).join(' ')}\n`;
  };
  console.error = (...args) => {
    stderr += `${args.map((arg) => String(arg)).join(' ')}\n`;
  };
  try {
    await fn();
    return { error: undefined, ok: true, stderr, stdout };
  } catch (error) {
    stderr += `${(error as Error).message}\n`;
    return { error: error as Error, ok: false, stderr, stdout };
  } finally {
    console.log = prevLog;
    console.error = prevErr;
  }
};
const all = (res: { stderr: string; stdout: string }) =>
  [res.stdout, res.stderr].filter(Boolean).join('\n');
const plain = (res: { stderr: string; stdout: string }) =>
  all(res).replace(/\x1b\[\d+(;\d+)*m/g, '');
const okJsrPublish = async () => {};
const spent = String.raw`(?:\d+h \d+min \d+s|\d+min \d+s|\d+s)`;
const load = (ver: Ver) => {
  const dir = join(ROOT, `ts-${ver}`);
  // Load each TS version in-process: spawning nested node/tsc commands gets EPERM in this harness.
  const req = createRequire(join(dir, 'package.json'));
  const raw = req('typescript');
  return ('default' in raw && raw.default ? raw.default : raw) as typeof import('typescript');
};
const text = (ts: typeof import('typescript'), diags: readonly import('typescript').Diagnostic[]) =>
  diags
    .map((d) => `TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`)
    .join('\n');
const compat = (ver: Ver, name: string) => {
  const ts = load(ver);
  const file = join(ROOT, `${name}.ts`);
  const prog = ts.createProgram([file], {
    allowImportingTsExtensions: true,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
    module: ts.ModuleKind.NodeNext || ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind?.NodeNext || ts.ModuleResolutionKind?.Bundler,
    noEmit: true,
    strict: true,
    target: ts.ScriptTarget.ESNext,
  });
  const diags = ts.getPreEmitDiagnostics(prog);
  return { ok: !diags.length, text: text(ts, diags) };
};
const boundary = (prodVer: Ver, consVer: Ver) => {
  const prodTs = load(prodVer);
  const consTs = load(consVer);
  const dir = join(BUILD, `prod-${prodVer}__cons-${consVer}`);
  const pkg = join(dir, 'node_modules', 'bytes-producer');
  const prodFile = join(pkg, 'index.ts');
  const consFile = join(dir, 'consumer.ts');
  rmSync(dir, { force: true, recursive: true });
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }, undefined, 2));
  writeFileSync(
    join(pkg, 'package.json'),
    JSON.stringify({ name: 'bytes-producer', type: 'module', types: './index.d.ts' }, undefined, 2)
  );
  writeFileSync(prodFile, readFileSync(join(ROOT, 'boundary', 'producer.ts'), 'utf8'));
  const prodProg = prodTs.createProgram([prodFile], {
    declaration: true,
    emitDeclarationOnly: true,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
    module: prodTs.ModuleKind.NodeNext || prodTs.ModuleKind.ESNext,
    moduleResolution: prodTs.ModuleResolutionKind?.NodeNext || prodTs.ModuleResolutionKind?.Bundler,
    noEmitOnError: true,
    strict: true,
    target: prodTs.ScriptTarget.ESNext,
  });
  const emit = prodProg.emit(undefined, undefined, undefined, true);
  const prodDiags = [...prodTs.getPreEmitDiagnostics(prodProg), ...emit.diagnostics];
  const dts = join(pkg, 'index.d.ts');
  if (prodDiags.length || emit.emitSkipped || !existsSync(dts))
    return { ok: false, stage: 'producer', text: text(prodTs, prodDiags) };
  rmSync(prodFile);
  writeFileSync(consFile, readFileSync(join(ROOT, 'boundary', 'consumer.ts'), 'utf8'));
  const consProg = consTs.createProgram([consFile], {
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
    module: consTs.ModuleKind.NodeNext || consTs.ModuleKind.ESNext,
    moduleResolution: consTs.ModuleResolutionKind?.NodeNext || consTs.ModuleResolutionKind?.Bundler,
    noEmit: true,
    strict: true,
    target: consTs.ScriptTarget.ESNext,
  });
  const consDiags = consTs.getPreEmitDiagnostics(consProg);
  return { ok: !consDiags.length, stage: 'consumer', text: text(consTs, consDiags) };
};
const polarity = (ver: Ver) => {
  const ts = load(ver);
  const dir = join(POLARITY_BUILD, `ts-${ver}`);
  const file = join(POLARITY, 'polarity.ts');
  const dts = join(dir, 'polarity.d.ts');
  rmSync(dir, { force: true, recursive: true });
  mkdirSync(dir, { recursive: true });
  const prog = ts.createProgram([file], {
    declaration: true,
    emitDeclarationOnly: true,
    isolatedDeclarations: true,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
    module: ts.ModuleKind.NodeNext || ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind?.NodeNext || ts.ModuleResolutionKind?.Bundler,
    noEmitOnError: true,
    outDir: dir,
    rootDir: POLARITY,
    strict: true,
    target: ts.ScriptTarget.ESNext,
  });
  const emit = prog.emit(undefined, undefined, undefined, true);
  const diags = [...ts.getPreEmitDiagnostics(prog), ...emit.diagnostics];
  return {
    dts: existsSync(dts) ? readFileSync(dts, 'utf8') : '',
    ok: !diags.length && !emit.emitSkipped && existsSync(dts),
    text: text(ts, diags),
  };
};

should('bytes passes on pass-root fixture', async () => {
  const cwd = resolve('test/jsbt/vectors/check/pass-root');
  const res = await capture(() =>
    runBytes(['package.json'], { color: false, cwd, loadTS: () => ts })
  );
  deepStrictEqual(res.ok, true);
  deepStrictEqual(/summary: 1 passed, 0 warnings, 0 failures, 0 skipped/.test(all(res)), true);
});

should('bytes handles recursive mapped generic helper types', async () => {
  const cwd = resolve('test/jsbt/vectors/bytes-cycle');
  const res = await capture(() =>
    runBytes(['package.json'], { color: false, cwd, loadTS: () => ts })
  );
  deepStrictEqual(res.ok, false, all(res));
  deepStrictEqual(
    /\[ERROR\] \(bytes\) utils\.ts:\d+\/helper update canonical bytes helper types in utils\.ts/.test(
      plain(res)
    ),
    true
  );
  deepStrictEqual(/utils\.ts:14\/return TRet<BytesCoder<SplitOut<T>>>/.test(plain(res)), true);
  deepStrictEqual(/utils\.ts:17\/return TRet<RetU8A>/.test(plain(res)), true);
  deepStrictEqual(/summary: 0 passed, 0 warnings, 3 failures, 0 skipped/.test(all(res)), true);
});

should('bytes reports missing canonical helper types before wrapper locations', async () => {
  const cwd = resolve('test/jsbt/vectors/bytes-helper-missing');
  const res = await capture(() =>
    runBytes(['package.json'], { color: false, cwd, loadTS: () => ts })
  );
  deepStrictEqual(res.ok, false);
  deepStrictEqual(
    /index\.ts:1\/helper add canonical bytes helper types to utils\.ts or index\.ts; use this block: \(bytes-helper\)\n  \/\*\*\n   \* Bytes API type helpers for old \+ new TypeScript\.\n   \* ?\n   \* TS 5\.6 has `Uint8Array`, while TS 5\.9\+ made it generic `Uint8Array<ArrayBuffer>`\.\n   \* We can't use specific return type, because TS 5\.6 will error\.\n   \* We can't use generic return type, because most TS 5\.9 software will expect specific type\.\n   \* ?\n   \* Maps typed-array input leaves to broad forms\.\n   \* These are compatibility adapters, not ownership guarantees\.\n   \* ?\n   \* - `TArg` keeps byte inputs broad\.\n   \* - `TRet` marks byte outputs for TS 5\.6 and TS 5\.9\+ compatibility\.\n   \*\/\n  export type TypedArg<T> = T extends BigInt64Array/.test(
      plain(res)
    ),
    true
  );
  deepStrictEqual(
    /export type TArg<T> = T \| \(\[TypedArg<T>\] extends \[never\]/.test(plain(res)),
    true
  );
  deepStrictEqual(/export type TRet<T> = T extends unknown/.test(plain(res)), true);
  deepStrictEqual(/\? T & \(\[TypedRet<T>\] extends \[never\]/.test(plain(res)), true);
  deepStrictEqual(/RetU8A/.test(plain(res)), false);
  deepStrictEqual(/index\.ts:1\/return TRet<Uint8Array>/.test(plain(res)), true);
  deepStrictEqual(/summary: 0 passed, 0 warnings, 2 failures, 0 skipped/.test(all(res)), true);
});

should('bytes ignores canonical helper internals', async () => {
  const cwd = resolve('test/jsbt/vectors/bytes-helper-only');
  const res = await capture(() =>
    runBytes(['package.json'], { color: false, cwd, loadTS: () => load('6.0.2') })
  );
  deepStrictEqual(res.ok, true, all(res));
  deepStrictEqual(/update canonical bytes helper types/.test(plain(res)), false);
  deepStrictEqual(/ReturnType<typeof Uint8Array\.of>/.test(plain(res)), false);
  deepStrictEqual(/summary: 2 passed, 0 warnings, 0 failures, 0 skipped/.test(all(res)), true);
});

should('bytes updates older helper docs to the noble-curves canonical block', async () => {
  const cwd = resolve('test/jsbt/vectors/bytes-helper-old');
  const res = await capture(() =>
    runBytes(['package.json'], { color: false, cwd, loadTS: () => load('6.0.2') })
  );
  deepStrictEqual(res.ok, false, all(res));
  deepStrictEqual(
    /\[ERROR\] \(bytes\) utils\.ts:\d+\/helper update canonical bytes helper types in utils\.ts/.test(
      plain(res)
    ),
    true
  );
  deepStrictEqual(/Bytes API type helpers for old \+ new TypeScript\./.test(plain(res)), true);
  deepStrictEqual(/See \{@link TypedArg\}\./.test(plain(res)), true);
  deepStrictEqual(/utils\.ts:101\/return TRet<Uint8Array>/.test(plain(res)), true);
  deepStrictEqual(/summary: 0 passed, 0 warnings, 2 failures, 0 skipped/.test(all(res)), true);
});

should('bytes accepts canonical TArg/TRet re-export helpers', async () => {
  const cwd = resolve('test/jsbt/vectors/bytes-helper-reexport');
  const res = await capture(() =>
    runBytes(['package.json'], { color: false, cwd, loadTS: () => load('6.0.2') })
  );
  deepStrictEqual(res.ok, false, all(res));
  deepStrictEqual(/canonical bytes helper types/.test(plain(res)), false);
  deepStrictEqual(/utils\.ts:4\/return TRet<Uint8Array>/.test(plain(res)), true);
  deepStrictEqual(/summary: 1 passed, 0 warnings, 1 failure, 0 skipped/.test(all(res)), true);
});

should('bytes handles object surfaces and nested function variance', async () => {
  const cwd = resolve('test/jsbt/vectors/bytes-surface');
  const res = await capture(() =>
    runBytes(['package.json'], { color: false, cwd, loadTS: () => ts })
  );
  deepStrictEqual(res.ok, false);
  deepStrictEqual(/utils\.ts:24\/return TRet<BadOut<Uint8Array>>/.test(plain(res)), true);
  deepStrictEqual(/utils\.ts:25\/return TRet<BadOut<Uint8Array>>/.test(plain(res)), true);
  deepStrictEqual(/utils\.ts:26\/return TRet<GoodOut<Uint8Array>>/.test(plain(res)), true);
  deepStrictEqual(/utils\.ts:27\/input TArg<InputRaw<Uint8Array>>/.test(plain(res)), true);
  deepStrictEqual(/utils\.ts:27\/input TArg<InputRet<Uint8Array>>/.test(plain(res)), true);
  deepStrictEqual(
    /utils\.ts:28\/input TArg<\(decode: \(bytes: Uint8Array\) => Uint8Array\) => void>/.test(
      plain(res)
    ),
    true
  );
  deepStrictEqual(
    /utils\.ts:29\/return TRet<\(encode: \(data: Uint8Array\) => RetU8A\) => Uint8Array>/.test(
      plain(res)
    ),
    true
  );
  deepStrictEqual(/summary: 0 passed, 0 warnings, 8 failures, 0 skipped/.test(plain(res)), true);
  deepStrictEqual(/Bytes check found issues/.test(plain(res)), true);
  deepStrictEqual(/field/.test(plain(res)), false);
});

should('bytes suggests mechanical TArg/TRet wrappers at API boundaries', async () => {
  const cwd = resolve('test/jsbt/vectors/bytes-wrap');
  const res = await capture(() =>
    runBytes(['package.json'], { color: false, cwd, loadTS: () => ts })
  );
  deepStrictEqual(res.ok, false);
  deepStrictEqual(
    /\[ERROR\] \(bytes\) utils\.ts:3\/helper update canonical bytes helper types in utils\.ts/.test(
      plain(res)
    ),
    true
  );
  deepStrictEqual(/utils\.ts:14\/return TRet<Surface>/.test(plain(res)), true);
  deepStrictEqual(/utils\.ts:16\/input TArg<Surface>/.test(plain(res)), true);
  deepStrictEqual(/utils\.ts:16\/input TArg<Uint8Array>/.test(plain(res)), true);
  deepStrictEqual(/utils\.ts:16\/return TRet<Surface>/.test(plain(res)), true);
  deepStrictEqual(/utils\.ts:18\/return Promise<TRet<Uint8Array>>/.test(plain(res)), true);
  deepStrictEqual(/utils\.ts:20\/return Promise<TRet<Uint8Array>>/.test(plain(res)), true);
  deepStrictEqual(plain(res).includes('wrapped'), false);
  deepStrictEqual(plain(res).includes('oid'), false);
  deepStrictEqual(/summary: 0 passed, 0 warnings, 7 failures, 0 skipped/.test(plain(res)), true);
});

should('bytes skips unsafe whole-object wrappers around opaque domain objects', async () => {
  const cwd = resolve('test/jsbt/vectors/bytes-opaque');
  const res = await capture(() =>
    runBytes(['package.json'], { color: false, cwd, loadTS: () => ts })
  );
  const out = plain(res);
  deepStrictEqual(res.ok, false);
  deepStrictEqual(/TArg<FrostOpts<P>>/.test(out), false);
  deepStrictEqual(/TRet<H2CHasher<PC>>/.test(out), false);
  deepStrictEqual(/TRet<H2CHasher<typeof ConcretePoint>>/.test(out), false);
  deepStrictEqual(/index\.ts:\d+\/return TRet<PlainSurface>/.test(out), true);
  deepStrictEqual(/index\.ts:\d+\/return TRet<GenericSurface<string>>/.test(out), true);
  deepStrictEqual(/index\.ts:\d+\/input TArg<Field<T>>/.test(out), true);
  deepStrictEqual(/index\.ts:\d+\/return TRet<Field<T>>/.test(out), true);
  deepStrictEqual(/index\.ts:\d+\/input TArg<Uint8Array>/.test(out), true);
  deepStrictEqual(/index\.ts:\d+\/return TRet<Uint8Array>/.test(out), true);
  deepStrictEqual(/summary: 0 passed, 0 warnings, 7 failures, 0 skipped/.test(out), true);
});

should('bytes reports input and output typed-array issues on bytes fixture', async () => {
  const cwd = ROOT;
  const res = await capture(() =>
    runBytes(['package.json'], { color: false, cwd, loadTS: () => ts })
  );
  deepStrictEqual(res.ok, false);
  deepStrictEqual(
    /\[ERROR\] \(bytes\) utils\.ts:1\/helper update canonical bytes helper types in utils\.ts/.test(
      plain(res)
    ),
    true
  );
  deepStrictEqual(
    /defaults\.ts:\d+\/generic avoid default byte generic parameter ReturnType<typeof Uint8Array\.of> on T; spell Uint8Array or ReturnType<typeof Uint8Array\.of> explicitly at use sites \(bytes-default\)/.test(
      plain(res)
    ),
    true
  );
  deepStrictEqual(
    /defaults\.ts:\d+\/generic avoid default byte generic parameter Uint8Array on T; spell Uint8Array or ReturnType<typeof Uint8Array\.of> explicitly at use sites \(bytes-default\)/.test(
      plain(res)
    ),
    true
  );
  deepStrictEqual(
    /2x avoid generic Uint8Array<ArrayBuffer>; use TArg<Uint8Array> in input types or TRet<Uint8Array> in output types \(bytes-generic\)\n  args\.ts:\d+\/generic/.test(
      plain(res)
    ),
    true
  );
  deepStrictEqual(/args\.ts:\d+\/input TArg<Uint8Array>/.test(plain(res)), true);
  deepStrictEqual(/args\.ts:\d+\/input TArg<RetU8A>/.test(plain(res)), true);
  deepStrictEqual(
    /2x avoid generic Uint8Array<SharedArrayBuffer>; use TArg<Uint8Array> in input types or TRet<Uint8Array> in output types \(bytes-generic\)[\s\S]*convert\.ts:\d+\/generic/.test(
      plain(res)
    ),
    true
  );
  deepStrictEqual(/gaming-alias-chain\.ts:\d+\/input TArg<Box>/.test(plain(res)), true);
  deepStrictEqual(/gaming-conditional\.ts:\d+\/input TArg<Box>/.test(plain(res)), true);
  deepStrictEqual(/gaming-indexed\.ts:\d+\/input TArg<Box>/.test(plain(res)), true);
  deepStrictEqual(/gaming-returntype\.ts:\d+\/input TArg<Box>/.test(plain(res)), true);
  deepStrictEqual(/gaming\.ts:\d+\/input TArg<Box>/.test(plain(res)), true);
  deepStrictEqual(/gaming-ok\.ts:\d+\/input TArg<Box<Uint8Array>>/.test(plain(res)), true);
  deepStrictEqual(/gaming-ok\.ts:\d+\/return TRet<Box<RetU8A>>/.test(plain(res)), true);
  deepStrictEqual(/example1\.ts:\d+\/return TRet<Uint8Array>/.test(plain(res)), true);
  deepStrictEqual(
    /example2\.ts:\d+\/generic avoid generic Uint8Array<ArrayBuffer>; use TRet<Uint8Array> in output types \(bytes-generic\)/.test(
      plain(res)
    ),
    true
  );
  deepStrictEqual(/example4\.ts:\d+\/input TArg<RetU8A>/.test(plain(res)), true);
  deepStrictEqual(/example4\.ts:\d+\/return TRet<Uint8Array>/.test(plain(res)), true);
  deepStrictEqual(/imported\.ts:\d+\/input TArg<Buf>/.test(plain(res)), true);
  deepStrictEqual(/namespace\.ts:\d+\/input TArg<t\.RetU8A>/.test(plain(res)), true);
  deepStrictEqual(
    /import-query\.ts:\d+\/input TArg<import\('\.\/utils\.ts'\)\.RetU8A>/.test(plain(res)),
    true
  );
  deepStrictEqual(
    /2x use Uint8Array in field types instead of RetU8A \(type RetU8A = ReturnType<typeof Uint8Array\.of>; return-only type\) \(bytes-field\)\n  classy\.ts:\d+\/field\n  example16\.ts:\d+\/field/.test(
      plain(res)
    ),
    true
  );
  deepStrictEqual(/classy\.ts:\d+\/input TArg<InputBox>/.test(plain(res)), true);
  deepStrictEqual(/classy\.ts:\d+\/return TRet<OutputBox>/.test(plain(res)), true);
  deepStrictEqual(/nested\.ts:\d+\/generic/.test(plain(res)), true);
  deepStrictEqual(/nested\.ts:\d+\/return TRet<Output>/.test(plain(res)), true);
  deepStrictEqual(/nested\.ts:\d+\/field/.test(plain(res)), false);
  deepStrictEqual(/reexport\.ts:\d+\/input TArg<Buf2>/.test(plain(res)), true);
  deepStrictEqual(plain(res).includes('methods.ts:'), false);
  deepStrictEqual(/example5\.ts:\d+\/input TArg<Input>/.test(plain(res)), true);
  deepStrictEqual(/example6\.ts:\d+\/input TArg<Input>/.test(plain(res)), true);
  deepStrictEqual(/example7\.ts:\d+\/return TRet<Output>/.test(plain(res)), true);
  deepStrictEqual(/example8\.ts:\d+\/return TRet<Output>/.test(plain(res)), true);
  deepStrictEqual(/example16\.ts:\d+\/field/.test(plain(res)), true);
  deepStrictEqual(/example16\.ts:\d+\/input TArg<InputBox>/.test(plain(res)), true);
  deepStrictEqual(/example16\.ts:\d+\/return TRet<OutputBox>/.test(plain(res)), true);
  deepStrictEqual(/example18\.ts:\d+\/input TArg<\{ buf: Uint8Array \}>/.test(plain(res)), true);
  deepStrictEqual(
    /2x avoid generic Uint32Array<ArrayBuffer>; use TRet<Uint32Array> in output types \(bytes-generic\)\n  example10\.ts:\d+\/generic/.test(
      plain(res)
    ),
    true
  );
  deepStrictEqual(
    /example12\.ts:\d+\/generic avoid generic Uint16Array<ArrayBuffer>; use TRet<Uint16Array> in output types \(bytes-generic\)/.test(
      plain(res)
    ),
    true
  );
  deepStrictEqual(/u32\.ts:\d+\/return TRet<Uint32Array>/.test(plain(res)), true);
  deepStrictEqual(/u32\.ts:\d+\/generic/.test(plain(res)), true);
  deepStrictEqual(
    /u32\.ts:\d+\/generic avoid generic typed-array alias Poly \(type Poly = Uint32Array<any>\); define type Poly = Uint32Array, then use TArg<Poly> in input types or TRet<Poly> in output types \(bytes-generic\)/.test(
      plain(res)
    ),
    true
  );
  deepStrictEqual(
    /u32\.ts:\d+\/generic avoid generic typed-array alias Poly \(type Poly = Uint32Array<any>\); define type Poly = Uint32Array, then use TRet<Poly> in output types \(bytes-generic\)/.test(
      plain(res)
    ),
    true
  );
  deepStrictEqual(/u32\.ts:\d+\/input TArg<RetU32A>/.test(plain(res)), true);
  deepStrictEqual(/summary: 7 passed, 0 warnings, 60 failures, 0 skipped/.test(all(res)), true);
  deepStrictEqual(/Bytes check found issues/.test(all(res)), true);
});

should('bytes compatibility probes keep TS 5.6.3 / 6.0.2 matrix', () => {
  const matrix = {
    '5.6.3': {
      args: { ok: false, pat: /TS2315: Type 'Uint8Array' is not generic/ },
      convert: { ok: false, pat: /TS2315: Type 'Uint8Array' is not generic/ },
      example1: { ok: true },
      example2: { ok: false, pat: /TS2315: Type 'Uint8Array' is not generic/ },
      example3: { ok: true },
      example4: { ok: true },
      example5: { ok: true },
      example6: { ok: true },
      example7: { ok: true },
      example8: { ok: true },
      example9: { ok: true },
      example10: { ok: false, pat: /TS2315: Type 'Uint32Array' is not generic/ },
      example11: { ok: true },
      example12: { ok: false, pat: /TS2315: Type 'Uint16Array' is not generic/ },
      example13: { ok: true },
      example14: { ok: true },
      example15: { ok: true },
      example16: { ok: true },
      example17: { ok: true },
      example18: { ok: true },
      example19: { ok: true },
      example20: { ok: true },
    },
    '6.0.2': {
      args: { ok: false, pat: /not assignable to parameter of type 'Uint8Array<ArrayBuffer>'/ },
      convert: { ok: true },
      example1: { ok: false, pat: /not assignable to parameter of type 'BufferSource'/ },
      example2: { ok: true },
      example3: { ok: true },
      example4: { ok: false, pat: /not assignable to parameter of type 'Uint8Array<ArrayBuffer>'/ },
      example5: { ok: false, pat: /not assignable to parameter of type 'Input'/ },
      example6: { ok: true },
      example7: { ok: false, pat: /not assignable to parameter of type 'BufferSource'/ },
      example8: { ok: true },
      example9: { ok: true },
      example10: { ok: true },
      example11: { ok: true },
      example12: { ok: true },
      example13: { ok: true },
      example14: { ok: true },
      example15: { ok: true },
      example16: { ok: true },
      example17: { ok: true },
      example18: { ok: true },
      example19: { ok: true },
      example20: { ok: false, pat: /not assignable to type 'RetDecoder'/ },
    },
  } as const;
  for (const [ver, checks] of Object.entries(matrix))
    for (const [name, want] of Object.entries(checks)) {
      const res = compat(ver as '5.6.3' | '6.0.2', name);
      deepStrictEqual(res.ok, want.ok, `${ver} ${name}`);
      if (!want.ok) deepStrictEqual(want.pat.test(res.text), true, `${ver} ${name}`);
    }
});

should(
  'bytes declaration boundary stays compatible across producer and consumer TS versions',
  () => {
    for (const prodVer of ['5.6.3', '6.0.2'] as const)
      for (const consVer of ['5.6.3', '6.0.2'] as const) {
        const res = boundary(prodVer, consVer);
        deepStrictEqual(res.ok, true, `${res.stage} ${prodVer} -> ${consVer}\n${res.text}`);
      }
  }
);

should('bytes polarity helpers handle deep shapes with isolated declarations', () => {
  for (const ver of ['5.6.3', '6.0.2'] as const) {
    const res = polarity(ver);
    deepStrictEqual(res.ok, true, `${ver}\n${res.text}`);
    deepStrictEqual(/export type TArg<T> =/.test(res.dts), true);
    deepStrictEqual(/export type TypedRet<T> = T extends BigInt64Array/.test(res.dts), true);
    deepStrictEqual(/\? ReturnType<typeof BigInt64Array\.of>/.test(res.dts), true);
    deepStrictEqual(/\? ReturnType<typeof Uint32Array\.of>/.test(res.dts), true);
    deepStrictEqual(/\? ReturnType<typeof Uint8Array\.of>/.test(res.dts), true);
    deepStrictEqual(/export type RetU8A =/.test(res.dts), false);
    deepStrictEqual(/all: AllTyped;/.test(res.dts), true);
    deepStrictEqual(
      /mixed\(cb: \(value: Float32Array\) => BigInt64Array\): Uint8ClampedArray;/.test(res.dts),
      true
    );
    deepStrictEqual(
      /export declare function api\(arg: TArg<DeepShape>\): TRet<DeepShape>;/.test(res.dts),
      true
    );
    deepStrictEqual(/export declare const sampleArg: TArg<DeepShape>;/.test(res.dts), true);
    deepStrictEqual(/export declare const sampleRet: TRet<DeepShape>;/.test(res.dts), true);
    deepStrictEqual(res.dts.length < 9000, true);
  }
});

should('check includes bytes results', async () => {
  const cwd = resolve('test/jsbt/vectors/check/pass-root');
  const res = await capture(() =>
    runJsbt(['check'], { color: false, cwd, runJsrPublish: okJsrPublish })
  );
  deepStrictEqual(res.ok, true);
  const heads = [
    'readme',
    'treeshake',
    'tsdoc',
    'typeimport',
    'jsr',
    'jsrpublish',
    'comments',
    'errors',
    'bigint',
    'bytes',
    'mutate',
    'tests',
    'importtime',
  ];
  deepStrictEqual(
    new RegExp(
      `jsbt check done in ${spent}: ${heads.map((head) => `${head}\\(0, ${spent}\\)`).join(', ')}`
    ).test(all(res)),
    true
  );
});

should('check groups repeated bytes actions without changing counts', async () => {
  const cwd = resolve('test/jsbt/vectors/bytes-wrap');
  const res = await capture(() =>
    runJsbt(['check'], { color: false, cwd, runJsrPublish: okJsrPublish })
  );
  deepStrictEqual(res.ok, false);
  deepStrictEqual(
    /\[ERROR\] \(bytes\) utils\.ts:3\/helper update canonical bytes helper types in utils\.ts/.test(
      plain(res)
    ),
    true
  );
  deepStrictEqual(
    /export type TArg<T> = T \| \(\[TypedArg<T>\] extends \[never\]/.test(plain(res)),
    true
  );
  deepStrictEqual(/export type TRet<T> = T extends unknown/.test(plain(res)), true);
  deepStrictEqual(/\? T & \(\[TypedRet<T>\] extends \[never\]/.test(plain(res)), true);
  deepStrictEqual(
    /\[ERROR\] \(bytes\) 2x wrap output type with TRet<\.\.\.> \(bytes-return\)\n  utils\.ts:14\/return TRet<Surface>\n  utils\.ts:16\/return TRet<Surface>/.test(
      plain(res)
    ),
    true
  );
  deepStrictEqual(
    /\[ERROR\] \(bytes\) wrap output type with Promise<TRet<\.\.\.>> \(bytes-return\)\n  utils\.ts:18\/return Promise<TRet<Uint8Array>>/.test(
      plain(res)
    ),
    true
  );
  deepStrictEqual(
    /\[ERROR\] \(bytes\) use Promise<TRet<\.\.\.>> instead of TRet<Promise<\.\.\.>> \(bytes-return\)\n  utils\.ts:20\/return Promise<TRet<Uint8Array>>/.test(
      plain(res)
    ),
    true
  );
  deepStrictEqual(
    /\[ERROR\] \(bytes\) 2x wrap input type with TArg<\.\.\.> \(bytes-input\)\n  utils\.ts:16\/input TArg<Surface>\n  utils\.ts:16\/input TArg<Uint8Array>/.test(
      plain(res)
    ),
    true
  );
  deepStrictEqual(
    /\[ERROR\] \(bytes\) utils\.ts:14\/return wrap output type with TRet<Surface>/.test(plain(res)),
    false
  );
  deepStrictEqual(
    /\[ERROR\] \(bytes\) utils\.ts:16\/input wrap input type with TArg<Surface>/.test(plain(res)),
    false
  );
  deepStrictEqual(new RegExp(`bytes\\(7, ${spent}\\)`).test(plain(res)), true);
});

should.runWhen(import.meta.url);
