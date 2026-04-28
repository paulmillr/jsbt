import * as assert from 'node:assert';
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
  assert.equal(res.ok, true);
  assert.match(all(res), /summary: 1 passed, 0 warnings, 0 failures, 0 skipped/);
});

should('bytes handles recursive mapped generic helper types', async () => {
  const cwd = resolve('test/jsbt/vectors/bytes-cycle');
  const res = await capture(() =>
    runBytes(['package.json'], { color: false, cwd, loadTS: () => ts })
  );
  assert.equal(res.ok, false, all(res));
  assert.match(
    plain(res),
    /\[ERROR\] \(bytes\) utils\.ts:\d+\/helper update canonical bytes helper types in utils\.ts/
  );
  assert.match(plain(res), /utils\.ts:14\/return TRet<BytesCoder<SplitOut<T>>>/);
  assert.match(plain(res), /utils\.ts:17\/return TRet<RetU8A>/);
  assert.match(all(res), /summary: 0 passed, 0 warnings, 3 failures, 0 skipped/);
});

should('bytes reports missing canonical helper types before wrapper locations', async () => {
  const cwd = resolve('test/jsbt/vectors/bytes-helper-missing');
  const res = await capture(() =>
    runBytes(['package.json'], { color: false, cwd, loadTS: () => ts })
  );
  assert.equal(res.ok, false);
  assert.match(
    plain(res),
    /index\.ts:1\/helper add canonical bytes helper types to utils\.ts or index\.ts; use this block: \(bytes-helper\)\n  \/\*\*\n   \* Bytes API type helpers for old \+ new TypeScript\.\n   \* ?\n   \* TS 5\.6 has `Uint8Array`, while TS 5\.9\+ made it generic `Uint8Array<ArrayBuffer>`\.\n   \* We can't use specific return type, because TS 5\.6 will error\.\n   \* We can't use generic return type, because most TS 5\.9 software will expect specific type\.\n   \* ?\n   \* Maps typed-array input leaves to broad forms\.\n   \* These are compatibility adapters, not ownership guarantees\.\n   \* ?\n   \* - `TArg` keeps byte inputs broad\.\n   \* - `TRet` marks byte outputs for TS 5\.6 and TS 5\.9\+ compatibility\.\n   \*\/\n  export type TypedArg<T> = T extends BigInt64Array/
  );
  assert.match(plain(res), /export type TArg<T> = T \| \(\[TypedArg<T>\] extends \[never\]/);
  assert.match(plain(res), /export type TRet<T> = T extends unknown/);
  assert.match(plain(res), /\? T & \(\[TypedRet<T>\] extends \[never\]/);
  assert.doesNotMatch(plain(res), /RetU8A/);
  assert.match(plain(res), /index\.ts:1\/return TRet<Uint8Array>/);
  assert.match(all(res), /summary: 0 passed, 0 warnings, 2 failures, 0 skipped/);
});

should('bytes ignores canonical helper internals', async () => {
  const cwd = resolve('test/jsbt/vectors/bytes-helper-only');
  const res = await capture(() =>
    runBytes(['package.json'], { color: false, cwd, loadTS: () => load('6.0.2') })
  );
  assert.equal(res.ok, true, all(res));
  assert.doesNotMatch(plain(res), /update canonical bytes helper types/);
  assert.doesNotMatch(plain(res), /ReturnType<typeof Uint8Array\.of>/);
  assert.match(all(res), /summary: 2 passed, 0 warnings, 0 failures, 0 skipped/);
});

should('bytes updates older helper docs to the noble-curves canonical block', async () => {
  const cwd = resolve('test/jsbt/vectors/bytes-helper-old');
  const res = await capture(() =>
    runBytes(['package.json'], { color: false, cwd, loadTS: () => load('6.0.2') })
  );
  assert.equal(res.ok, false, all(res));
  assert.match(
    plain(res),
    /\[ERROR\] \(bytes\) utils\.ts:\d+\/helper update canonical bytes helper types in utils\.ts/
  );
  assert.match(plain(res), /Bytes API type helpers for old \+ new TypeScript\./);
  assert.match(plain(res), /See \{@link TypedArg\}\./);
  assert.match(plain(res), /utils\.ts:101\/return TRet<Uint8Array>/);
  assert.match(all(res), /summary: 0 passed, 0 warnings, 2 failures, 0 skipped/);
});

should('bytes accepts canonical TArg/TRet re-export helpers', async () => {
  const cwd = resolve('test/jsbt/vectors/bytes-helper-reexport');
  const res = await capture(() =>
    runBytes(['package.json'], { color: false, cwd, loadTS: () => load('6.0.2') })
  );
  assert.equal(res.ok, false, all(res));
  assert.doesNotMatch(plain(res), /canonical bytes helper types/);
  assert.match(plain(res), /utils\.ts:4\/return TRet<Uint8Array>/);
  assert.match(all(res), /summary: 0 passed, 0 warnings, 1 failure, 0 skipped/);
});

should('bytes handles object surfaces and nested function variance', async () => {
  const cwd = resolve('test/jsbt/vectors/bytes-surface');
  const res = await capture(() =>
    runBytes(['package.json'], { color: false, cwd, loadTS: () => ts })
  );
  assert.equal(res.ok, false);
  assert.match(plain(res), /utils\.ts:24\/return TRet<BadOut<Uint8Array>>/);
  assert.match(plain(res), /utils\.ts:25\/return TRet<BadOut<Uint8Array>>/);
  assert.match(plain(res), /utils\.ts:26\/return TRet<GoodOut<Uint8Array>>/);
  assert.match(plain(res), /utils\.ts:27\/input TArg<InputRaw<Uint8Array>>/);
  assert.match(plain(res), /utils\.ts:27\/input TArg<InputRet<Uint8Array>>/);
  assert.match(
    plain(res),
    /utils\.ts:28\/input TArg<\(decode: \(bytes: Uint8Array\) => Uint8Array\) => void>/
  );
  assert.match(
    plain(res),
    /utils\.ts:29\/return TRet<\(encode: \(data: Uint8Array\) => RetU8A\) => Uint8Array>/
  );
  assert.match(plain(res), /summary: 0 passed, 0 warnings, 8 failures, 0 skipped/);
  assert.match(plain(res), /Bytes check found issues/);
  assert.doesNotMatch(plain(res), /field/);
});

should('bytes suggests mechanical TArg/TRet wrappers at API boundaries', async () => {
  const cwd = resolve('test/jsbt/vectors/bytes-wrap');
  const res = await capture(() =>
    runBytes(['package.json'], { color: false, cwd, loadTS: () => ts })
  );
  assert.equal(res.ok, false);
  assert.match(
    plain(res),
    /\[ERROR\] \(bytes\) utils\.ts:3\/helper update canonical bytes helper types in utils\.ts/
  );
  assert.match(plain(res), /utils\.ts:14\/return TRet<Surface>/);
  assert.match(plain(res), /utils\.ts:16\/input TArg<Surface>/);
  assert.match(plain(res), /utils\.ts:16\/input TArg<Uint8Array>/);
  assert.match(plain(res), /utils\.ts:16\/return TRet<Surface>/);
  assert.match(plain(res), /utils\.ts:18\/return Promise<TRet<Uint8Array>>/);
  assert.match(plain(res), /utils\.ts:20\/return Promise<TRet<Uint8Array>>/);
  assert.equal(plain(res).includes('wrapped'), false);
  assert.equal(plain(res).includes('oid'), false);
  assert.match(plain(res), /summary: 0 passed, 0 warnings, 7 failures, 0 skipped/);
});

should('bytes skips unsafe whole-object wrappers around opaque domain objects', async () => {
  const cwd = resolve('test/jsbt/vectors/bytes-opaque');
  const res = await capture(() =>
    runBytes(['package.json'], { color: false, cwd, loadTS: () => ts })
  );
  const out = plain(res);
  assert.equal(res.ok, false);
  assert.doesNotMatch(out, /TArg<FrostOpts<P>>/);
  assert.doesNotMatch(out, /TRet<H2CHasher<PC>>/);
  assert.doesNotMatch(out, /TRet<H2CHasher<typeof ConcretePoint>>/);
  assert.match(out, /index\.ts:\d+\/return TRet<PlainSurface>/);
  assert.match(out, /index\.ts:\d+\/return TRet<GenericSurface<string>>/);
  assert.match(out, /index\.ts:\d+\/input TArg<Field<T>>/);
  assert.match(out, /index\.ts:\d+\/return TRet<Field<T>>/);
  assert.match(out, /index\.ts:\d+\/input TArg<Uint8Array>/);
  assert.match(out, /index\.ts:\d+\/return TRet<Uint8Array>/);
  assert.match(out, /summary: 0 passed, 0 warnings, 7 failures, 0 skipped/);
});

should('bytes reports input and output typed-array issues on bytes fixture', async () => {
  const cwd = ROOT;
  const res = await capture(() =>
    runBytes(['package.json'], { color: false, cwd, loadTS: () => ts })
  );
  assert.equal(res.ok, false);
  assert.match(
    plain(res),
    /\[ERROR\] \(bytes\) utils\.ts:1\/helper update canonical bytes helper types in utils\.ts/
  );
  assert.match(
    plain(res),
    /defaults\.ts:\d+\/generic avoid default byte generic parameter ReturnType<typeof Uint8Array\.of> on T; spell Uint8Array or ReturnType<typeof Uint8Array\.of> explicitly at use sites \(bytes-default\)/
  );
  assert.match(
    plain(res),
    /defaults\.ts:\d+\/generic avoid default byte generic parameter Uint8Array on T; spell Uint8Array or ReturnType<typeof Uint8Array\.of> explicitly at use sites \(bytes-default\)/
  );
  assert.match(
    plain(res),
    /2x avoid generic Uint8Array<ArrayBuffer>; use TArg<Uint8Array> in input types or TRet<Uint8Array> in output types \(bytes-generic\)\n  args\.ts:\d+\/generic/
  );
  assert.match(plain(res), /args\.ts:\d+\/input TArg<Uint8Array>/);
  assert.match(plain(res), /args\.ts:\d+\/input TArg<RetU8A>/);
  assert.match(
    plain(res),
    /2x avoid generic Uint8Array<SharedArrayBuffer>; use TArg<Uint8Array> in input types or TRet<Uint8Array> in output types \(bytes-generic\)[\s\S]*convert\.ts:\d+\/generic/
  );
  assert.match(plain(res), /gaming-alias-chain\.ts:\d+\/input TArg<Box>/);
  assert.match(plain(res), /gaming-conditional\.ts:\d+\/input TArg<Box>/);
  assert.match(plain(res), /gaming-indexed\.ts:\d+\/input TArg<Box>/);
  assert.match(plain(res), /gaming-returntype\.ts:\d+\/input TArg<Box>/);
  assert.match(plain(res), /gaming\.ts:\d+\/input TArg<Box>/);
  assert.match(plain(res), /gaming-ok\.ts:\d+\/input TArg<Box<Uint8Array>>/);
  assert.match(plain(res), /gaming-ok\.ts:\d+\/return TRet<Box<RetU8A>>/);
  assert.match(plain(res), /example1\.ts:\d+\/return TRet<Uint8Array>/);
  assert.match(
    plain(res),
    /example2\.ts:\d+\/generic avoid generic Uint8Array<ArrayBuffer>; use TRet<Uint8Array> in output types \(bytes-generic\)/
  );
  assert.match(plain(res), /example4\.ts:\d+\/input TArg<RetU8A>/);
  assert.match(plain(res), /example4\.ts:\d+\/return TRet<Uint8Array>/);
  assert.match(plain(res), /imported\.ts:\d+\/input TArg<Buf>/);
  assert.match(plain(res), /namespace\.ts:\d+\/input TArg<t\.RetU8A>/);
  assert.match(plain(res), /import-query\.ts:\d+\/input TArg<import\('\.\/utils\.ts'\)\.RetU8A>/);
  assert.match(
    plain(res),
    /2x use Uint8Array in field types instead of RetU8A \(type RetU8A = ReturnType<typeof Uint8Array\.of>; return-only type\) \(bytes-field\)\n  classy\.ts:\d+\/field\n  example16\.ts:\d+\/field/
  );
  assert.match(plain(res), /classy\.ts:\d+\/input TArg<InputBox>/);
  assert.match(plain(res), /classy\.ts:\d+\/return TRet<OutputBox>/);
  assert.match(plain(res), /nested\.ts:\d+\/generic/);
  assert.match(plain(res), /nested\.ts:\d+\/return TRet<Output>/);
  assert.doesNotMatch(plain(res), /nested\.ts:\d+\/field/);
  assert.match(plain(res), /reexport\.ts:\d+\/input TArg<Buf2>/);
  assert.equal(plain(res).includes('methods.ts:'), false);
  assert.match(plain(res), /example5\.ts:\d+\/input TArg<Input>/);
  assert.match(plain(res), /example6\.ts:\d+\/input TArg<Input>/);
  assert.match(plain(res), /example7\.ts:\d+\/return TRet<Output>/);
  assert.match(plain(res), /example8\.ts:\d+\/return TRet<Output>/);
  assert.match(plain(res), /example16\.ts:\d+\/field/);
  assert.match(plain(res), /example16\.ts:\d+\/input TArg<InputBox>/);
  assert.match(plain(res), /example16\.ts:\d+\/return TRet<OutputBox>/);
  assert.match(plain(res), /example18\.ts:\d+\/input TArg<\{ buf: Uint8Array \}>/);
  assert.match(
    plain(res),
    /2x avoid generic Uint32Array<ArrayBuffer>; use TRet<Uint32Array> in output types \(bytes-generic\)\n  example10\.ts:\d+\/generic/
  );
  assert.match(
    plain(res),
    /example12\.ts:\d+\/generic avoid generic Uint16Array<ArrayBuffer>; use TRet<Uint16Array> in output types \(bytes-generic\)/
  );
  assert.match(plain(res), /u32\.ts:\d+\/return TRet<Uint32Array>/);
  assert.match(plain(res), /u32\.ts:\d+\/generic/);
  assert.match(
    plain(res),
    /u32\.ts:\d+\/generic avoid generic typed-array alias Poly \(type Poly = Uint32Array<any>\); define type Poly = Uint32Array, then use TArg<Poly> in input types or TRet<Poly> in output types \(bytes-generic\)/
  );
  assert.match(
    plain(res),
    /u32\.ts:\d+\/generic avoid generic typed-array alias Poly \(type Poly = Uint32Array<any>\); define type Poly = Uint32Array, then use TRet<Poly> in output types \(bytes-generic\)/
  );
  assert.match(plain(res), /u32\.ts:\d+\/input TArg<RetU32A>/);
  assert.match(all(res), /summary: 7 passed, 0 warnings, 60 failures, 0 skipped/);
  assert.match(all(res), /Bytes check found issues/);
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
      assert.equal(res.ok, want.ok, `${ver} ${name}`);
      if (!want.ok) assert.match(res.text, want.pat, `${ver} ${name}`);
    }
});

should(
  'bytes declaration boundary stays compatible across producer and consumer TS versions',
  () => {
    for (const prodVer of ['5.6.3', '6.0.2'] as const)
      for (const consVer of ['5.6.3', '6.0.2'] as const) {
        const res = boundary(prodVer, consVer);
        assert.equal(res.ok, true, `${res.stage} ${prodVer} -> ${consVer}\n${res.text}`);
      }
  }
);

should('bytes polarity helpers handle deep shapes with isolated declarations', () => {
  for (const ver of ['5.6.3', '6.0.2'] as const) {
    const res = polarity(ver);
    assert.equal(res.ok, true, `${ver}\n${res.text}`);
    assert.match(res.dts, /export type TArg<T> =/);
    assert.match(res.dts, /export type TypedRet<T> = T extends BigInt64Array/);
    assert.match(res.dts, /\? ReturnType<typeof BigInt64Array\.of>/);
    assert.match(res.dts, /\? ReturnType<typeof Uint32Array\.of>/);
    assert.match(res.dts, /\? ReturnType<typeof Uint8Array\.of>/);
    assert.doesNotMatch(res.dts, /export type RetU8A =/);
    assert.match(res.dts, /all: AllTyped;/);
    assert.match(
      res.dts,
      /mixed\(cb: \(value: Float32Array\) => BigInt64Array\): Uint8ClampedArray;/
    );
    assert.match(res.dts, /export declare function api\(arg: TArg<DeepShape>\): TRet<DeepShape>;/);
    assert.match(res.dts, /export declare const sampleArg: TArg<DeepShape>;/);
    assert.match(res.dts, /export declare const sampleRet: TRet<DeepShape>;/);
    assert.ok(res.dts.length < 9000, `${ver} declaration output too large: ${res.dts.length}`);
  }
});

should('check includes bytes results', async () => {
  const cwd = resolve('test/jsbt/vectors/check/pass-root');
  const res = await capture(() =>
    runJsbt(['check', 'package.json'], { color: false, cwd, runJsrPublish: okJsrPublish })
  );
  assert.equal(res.ok, true);
  assert.match(
    all(res),
    new RegExp(
      `jsbt check done in ${spent}: readme\\(0, ${spent}\\), treeshake\\(0, ${spent}\\), tsdoc\\(0, ${spent}\\), typeimport\\(0, ${spent}\\), jsr\\(0, ${spent}\\), jsrpublish\\(0, ${spent}\\), comments\\(0, ${spent}\\), bigint\\(0, ${spent}\\), bytes\\(0, ${spent}\\), mutate\\(0, ${spent}\\), tests\\(0, ${spent}\\), importtime\\(0, ${spent}\\)`
    )
  );
});

should('check groups repeated bytes actions without changing counts', async () => {
  const cwd = resolve('test/jsbt/vectors/bytes-wrap');
  const res = await capture(() =>
    runJsbt(['check', 'package.json'], { color: false, cwd, runJsrPublish: okJsrPublish })
  );
  assert.equal(res.ok, false);
  assert.match(
    plain(res),
    /\[ERROR\] \(bytes\) utils\.ts:3\/helper update canonical bytes helper types in utils\.ts/
  );
  assert.match(plain(res), /export type TArg<T> = T \| \(\[TypedArg<T>\] extends \[never\]/);
  assert.match(plain(res), /export type TRet<T> = T extends unknown/);
  assert.match(plain(res), /\? T & \(\[TypedRet<T>\] extends \[never\]/);
  assert.match(
    plain(res),
    /\[ERROR\] \(bytes\) 2x wrap output type with TRet<\.\.\.> \(bytes-return\)\n  utils\.ts:14\/return TRet<Surface>\n  utils\.ts:16\/return TRet<Surface>/
  );
  assert.match(
    plain(res),
    /\[ERROR\] \(bytes\) wrap output type with Promise<TRet<\.\.\.>> \(bytes-return\)\n  utils\.ts:18\/return Promise<TRet<Uint8Array>>/
  );
  assert.match(
    plain(res),
    /\[ERROR\] \(bytes\) use Promise<TRet<\.\.\.>> instead of TRet<Promise<\.\.\.>> \(bytes-return\)\n  utils\.ts:20\/return Promise<TRet<Uint8Array>>/
  );
  assert.match(
    plain(res),
    /\[ERROR\] \(bytes\) 2x wrap input type with TArg<\.\.\.> \(bytes-input\)\n  utils\.ts:16\/input TArg<Surface>\n  utils\.ts:16\/input TArg<Uint8Array>/
  );
  assert.doesNotMatch(
    plain(res),
    /\[ERROR\] \(bytes\) utils\.ts:14\/return wrap output type with TRet<Surface>/
  );
  assert.doesNotMatch(
    plain(res),
    /\[ERROR\] \(bytes\) utils\.ts:16\/input wrap input type with TArg<Surface>/
  );
  assert.match(plain(res), new RegExp(`bytes\\(7, ${spent}\\)`));
});

should.runWhen(import.meta.url);
