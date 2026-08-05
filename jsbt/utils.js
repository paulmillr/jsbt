import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { cpus } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { rm, write, writePkg } from "../fs-modify.js";
export const color = {
    dim: '\x1b[2m',
    gray: '\x1b[90m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    reset: '\x1b[0m',
    yellow: '\x1b[33m',
};
export const emptyResult = () => ({ failures: 0, passed: 0, skipped: 0, warnings: 0 });
const TS = new Set(['.cts', '.mts', '.ts', '.tsx']);
const TS_IMPORT_EXTS = ['.ts', '.mts', '.cts', '.tsx'];
const ROOT_IMPORT_TRAP = /root module cannot be imported: import submodules instead\./i;
const IMPORT_FILE_WORKER = `
import { parentPort, workerData } from 'node:worker_threads';
try {
  await import(workerData.file);
  parentPort?.postMessage({ ok: true });
} catch (err_) {
  console.error(err_);
  parentPort?.postMessage({ ok: false });
}
`;
export const stripAnsi = (line) => line.replace(/\x1b\[\d+(;\d+)*m/g, '');
export const err = (msg) => {
    throw new Error(msg);
};
export const parseFast = (str) => {
    const raw = String(str || '')
        .trim()
        .toLowerCase();
    if (raw === 'true')
        return 1;
    const val = Number.parseFloat(raw);
    const ratio = val > 0 && val < 1;
    if (!Number.isFinite(val) || val === 0 || Math.abs(val) > 256)
        return 0;
    if (!ratio && !Number.isSafeInteger(val))
        return 0;
    return val;
};
export const defaultFast = (env = process.env) => env.JSBT_FAST === undefined ? 1 : parseFast(env.JSBT_FAST);
export const fastWorkerCount = (fast, max = cpus().length) => {
    const count = fast === 1 ? max : fast < 0 ? max + fast : fast < 1 ? Math.floor(max * fast) : fast;
    return Math.max(1, Math.min(count, 256));
};
export const jsbtWorkerLimit = (_defaultCount) => {
    const fast = defaultFast();
    if (!fast)
        return 1;
    return fastWorkerCount(fast);
};
export const camelParts = (parts) => parts.map((part, i) => (i ? part[0].toUpperCase() + part.slice(1) : part)).join('');
export const fileUrl = (file) => pathToFileURL(file).href;
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
export const ident = (name) => !!name.length && IDENT.test(name);
export const kb = (bytes) => (bytes / 1024).toFixed(2);
// `isolatedDeclarations` cannot infer the Dirent overload for exported wrappers.
export const dirEntries = (dir) => readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
export const tsSourceRel = (rel) => rel
    .replace(/\.d\.(?:c|m)?ts$/, '.ts')
    .replace(/\.(?:c|m)?js$/, '.ts')
    .replace(/^\.\//, '');
export const readText = (file) => readFileSync(file, 'utf8');
export const readJson = (file) => JSON.parse(readText(file));
let sourceFileCaches = new WeakMap();
let sourceFileCacheDepth = 0;
export const withSourceFileCache = async (fn) => {
    sourceFileCacheDepth += 1;
    try {
        return await fn();
    }
    finally {
        sourceFileCacheDepth -= 1;
        if (sourceFileCacheDepth === 0)
            sourceFileCaches = new WeakMap();
    }
};
export const createCachedSourceFile = (ts, file, text, target = ts.ScriptTarget.ESNext, setParents = true) => {
    if (sourceFileCacheDepth <= 0)
        return ts.createSourceFile(file, text, target, setParents);
    const key = `${resolve(file)}\0${String(target)}\0${setParents ? '1' : '0'}`;
    let cache = sourceFileCaches.get(ts);
    if (!cache) {
        cache = new Map();
        sourceFileCaches.set(ts, cache);
    }
    const prev = cache.get(key);
    if (prev && prev.text === text && prev.target === target && prev.parents === setParents)
        return prev.source;
    const source = ts.createSourceFile(file, text, target, setParents);
    cache.set(key, { parents: setParents, source, target, text });
    return source;
};
export const readSource = (ts, file) => {
    const text = readText(file);
    return { source: createCachedSourceFile(ts, file, text), text };
};
export const textLines = (text = '', trimEnd = false) => text
    .split(/\r?\n/)
    .map((line) => (trimEnd ? line.trimEnd() : line.trim()))
    .filter(Boolean);
export const lineIndex = (text) => {
    const lines = [];
    const starts = [0];
    let pos = 0;
    for (const hit of text.matchAll(/\r?\n/g)) {
        const end = hit.index || 0;
        lines.push(text.slice(pos, end));
        pos = end + hit[0].length;
        starts.push(pos);
    }
    lines.push(text.slice(pos));
    const lineAt = (pos) => {
        let lo = 0;
        let hi = starts.length - 1;
        while (lo < hi) {
            const mid = Math.floor((lo + hi + 1) / 2);
            if (starts[mid] <= pos)
                lo = mid;
            else
                hi = mid - 1;
        }
        return lo;
    };
    return { lines, lineOf: lineAt, starts };
};
export const docCommentLines = (raw, trim = true) => raw
    .replace(/^\/\*\*|\*\/$/g, '')
    .split(/\r?\n/)
    .map((line) => {
    const text = line
        .replace(/^\s*\/\*\*?\s?/, '')
        .replace(/\s*\*\/\s*$/, '')
        .replace(/^\s*\*\s?/, '');
    return trim ? text.trim() : text.trimEnd();
});
export const firstText = (text = '') => textLines(text)[0] || '';
export const execText = (exec) => exec.error?.message || firstText(exec.stderr) || firstText(exec.stdout) || `exit ${exec.status}`;
export const compact = (items) => {
    const list = items.map((item) => item.trim()).filter(Boolean);
    if (!list.length)
        return '';
    if (list.length === 1)
        return list[0];
    return `${list.slice(0, 3).join('; ')}${list.length > 3 ? `; +${list.length - 3} more` : ''}`;
};
export const relFile = (cwd, file, insideOnly = false) => {
    const rel = cwd ? relative(cwd, file) : file;
    // Deno publish locations can point outside cwd; keep those absolute.
    const out = rel && rel !== '.' && (!insideOnly || (!rel.startsWith('..') && !isAbsolute(rel))) ? rel : file;
    return out.split('\\').join('/');
};
export const relName = (cwd, file) => relative(cwd, file) || basename(file);
export const nodeText = (node) => (typeof node?.text === 'string' ? node.text : '');
export const nodeStart = (source, node) => typeof node.getStart === 'function' ? node.getStart(source) : node.pos || 0;
export const nodeLine = (source, node) => source.getLineAndCharacterOfPosition(nodeStart(source, node)).line + 1;
export const walkAst = (ts, node, visit) => {
    // Visitors return false to keep consumed nodes from being traversed again.
    if (visit(node) === false)
        return;
    ts.forEachChild(node, (child) => walkAst(ts, child, visit));
};
export const literalText = (ts, node) => {
    // Re-export-only declarations have no moduleSpecifier; keep those as empty specs.
    if (!node)
        return '';
    return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral?.(node)
        ? node.text || ''
        : '';
};
export const importTypeText = (ts, node) => {
    if (!ts.isLiteralTypeNode?.(node?.argument))
        return '';
    return literalText(ts, node.argument.literal);
};
export const skipRootImportTrap = (row) => {
    if (!row.error || !ROOT_IMPORT_TRAP.test(row.error))
        return false;
    // Some noble packages intentionally make the root entry throw to force submodule imports.
    row.skip = true;
    row.error = undefined;
    return true;
};
const CH = '\u2500';
const NN = '\u2502';
const LR = '\u253c';
const RN = '\u251c';
const NL = '\u2524';
const joinBorders = (str) => str
    .replaceAll(`${CH}${NN}${CH}`, `${CH}${LR}${CH}`)
    .replaceAll(`${CH}${NN}`, `${CH}${NL}`)
    .replaceAll(`${NN}${CH}`, `${RN}${CH}`);
const pad = (s, len, end = true) => {
    const extra = len - stripAnsi(s).length;
    if (extra <= 0)
        return s;
    const fill = ' '.repeat(extra);
    return end ? s + fill : fill + s;
};
export const table = (log) => {
    const drawHeader = (sizes, fields) => log(fields.map((name, i) => `${name.padEnd(sizes[i])} `).join(NN));
    const drawSeparator = (sizes, changed) => {
        const sep = sizes.map((size, i) => (changed[i] ? CH : ' ').repeat(size + 1));
        log(joinBorders(sep.join(NN)));
    };
    const printRow = (values, prev, sizes, selected) => {
        const changed = values.map(() => true);
        for (let i = 0, parentChanged = false; i < selected.length; i++) {
            const curChanged = parentChanged || !prev || values[i] !== prev[i];
            changed[i] = curChanged;
            if (curChanged)
                parentChanged = true;
        }
        const head = changed.slice(0, selected.length);
        const skip = head.length < 2 ? true : head.slice(0, -1).every((v) => !v) && !!head.at(-1);
        if (!skip)
            drawSeparator(sizes, changed);
        log(values
            .map((val, i) => pad(!changed[i] ? ' ' : val, sizes[i] + 1, i < selected.length))
            .join(NN));
        return values;
    };
    return { drawHeader, drawSeparator, printRow };
};
const flattenDiagnostic = (msg) => {
    if (typeof msg === 'string')
        return msg;
    const head = msg.messageText ? flattenDiagnostic(msg.messageText) : '';
    const tail = (msg.next || []).map(flattenDiagnostic).filter(Boolean).join(' ');
    return [head, tail].filter(Boolean).join(' ');
};
const tsOpts = (ts, cwd) => {
    const file = ts.findConfigFile?.(cwd, ts.sys.fileExists, 'tsconfig.json');
    const base = (() => {
        if (!file || !ts.readConfigFile || !ts.parseJsonConfigFileContent)
            return {};
        const res = ts.readConfigFile(file, ts.sys.readFile);
        if (res.error)
            return {};
        return ts.parseJsonConfigFileContent(res.config || {}, ts.sys, dirname(file)).options || {};
    })();
    return {
        ...base,
        allowImportingTsExtensions: true,
        module: base.module || ts.ModuleKind.NodeNext || ts.ModuleKind.ESNext,
        moduleResolution: base.moduleResolution ||
            ts.ModuleResolutionKind?.NodeNext ||
            ts.ModuleResolutionKind?.Bundler,
        noEmit: true,
        noUnusedLocals: false,
        noUnusedParameters: false,
        rootDir: cwd,
        skipLibCheck: true,
        target: base.target || ts.ScriptTarget.ESNext,
    };
};
export const makeTypeCheck = (ts, cwd, fileName = '.__jsbt-check.ts') => {
    const file = join(cwd, fileName);
    const opts = tsOpts(ts, cwd);
    const host = ts.createCompilerHost(opts);
    const fileExists = host.fileExists?.bind(host) || ts.sys.fileExists;
    const readFile = host.readFile?.bind(host) || ts.sys.readFile;
    const getSourceFile = host.getSourceFile?.bind(host);
    const sys = ts.sys;
    const cache = new Map();
    let code = '';
    let oldProgram;
    host.fileExists = (name) => (resolve(name) === file ? true : fileExists(name));
    host.readFile = (name) => (resolve(name) === file ? code : readFile(name));
    host.getCurrentDirectory = () => cwd;
    host.getDirectories = (dir) => sys.getDirectories(dir);
    host.realpath = (name) => sys.realpath?.(name) || name;
    host.useCaseSensitiveFileNames = () => sys.useCaseSensitiveFileNames;
    host.writeFile = () => { };
    host.getSourceFile = (name, target, onError) => {
        if (resolve(name) === file)
            return ts.createSourceFile(name, code, target, true);
        const key = `${resolve(name)}:${String(target)}`;
        if (cache.has(key))
            return cache.get(key);
        if (!getSourceFile)
            return undefined;
        const sf = getSourceFile(name, target, onError);
        if (sf)
            cache.set(key, sf);
        return sf;
    };
    return (value) => {
        code = value;
        const prog = ts.createProgram([file], opts, host, oldProgram);
        oldProgram = prog;
        return ts
            .getPreEmitDiagnostics(prog)
            .filter((diag) => !diag.file || diag.file.fileName === file)
            .map((diag) => ts.flattenDiagnosticMessageText
            ? ts.flattenDiagnosticMessageText(diag.messageText, '\n')
            : flattenDiagnostic(diag.messageText))
            .filter(Boolean);
    };
};
export const bundled = () => typeof __JSBT_BUNDLE__ !== 'undefined' && __JSBT_BUNDLE__;
export const runSelf = (metaUrl, fn) => {
    const entry = process.argv[1];
    const self = fileURLToPath(metaUrl);
    if (bundled() || !entry || realpathSync(resolve(entry)) !== realpathSync(self))
        return;
    void (async () => {
        try {
            await fn(process.argv.slice(2));
        }
        catch (error) {
            console.error(error.message);
            process.exitCode = 1;
        }
    })();
};
export const pkgArgs = (argv) => {
    if (argv.includes('--help') || argv.includes('-h'))
        return { help: true, pkgArg: '' };
    if (argv.length !== 1)
        throw new Error('expected <package.json>');
    return { help: false, pkgArg: argv[0] };
};
export const usageText = (cmd, file) => `usage:
  jsbt ${cmd} <package.json>

examples:
  jsbt ${cmd} package.json
  node /path/to/${file} package.json`;
export const cliArgs = (argv, usage, color) => {
    const args = pkgArgs(argv);
    if (args.help) {
        console.log(usage);
        return undefined;
    }
    return { args, colorOn: color ?? wantColor() };
};
export const pickRunDir = (cwd, name) => {
    const dir = join(cwd, 'test', 'build');
    const file = join(dir, 'package.json');
    if (!existsSync(file))
        throw new Error(`expected test/build/package.json next to ${name || 'package.json'}`);
    const pkg = readJson(file);
    const dep = pkg.dependencies?.[name] || pkg.devDependencies?.[name] || pkg.optionalDependencies?.[name];
    if (dep !== 'file:../..') {
        throw new Error([
            `expected test/build/package.json to install ${name} as "file:../.."`,
            `got ${JSON.stringify(dep)}`,
        ].join('; '));
    }
    return dir;
};
export const prepareRunDir = (cwd, name, dir) => {
    if (!isAbsolute(dir))
        err(`expected absolute run dir: ${dir}`);
    const template = join(pickRunDir(cwd, name), 'package.json');
    const pkg = readJson(template);
    let rewrote = false;
    for (const deps of [pkg.dependencies, pkg.devDependencies, pkg.optionalDependencies]) {
        if (deps?.[name] !== 'file:../..')
            continue;
        deps[name] = `file:${cwd}`;
        rewrote = true;
    }
    if (!rewrote)
        err(`expected ${template} to install ${name} as "file:../.."`);
    writePkg(join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
    return dir;
};
export const withRunDir = (ctx, runDir) => ({
    ...ctx,
    runDir: runDir ? prepareRunDir(ctx.cwd, ctx.pkg.name, runDir) : pickRunDir(ctx.cwd, ctx.pkg.name),
});
export const loadNear = (pkgFile, name, api, check) => {
    const req = createRequire(pkgFile);
    const raw = (() => {
        try {
            return req(name);
        }
        catch {
            throw new Error(`missing ${name} near ${pkgFile}; run npm install in the target repo first`);
        }
    })();
    const mod = raw && typeof raw === 'object' && 'default' in raw && raw.default ? raw.default : raw;
    if (!check(mod))
        throw new Error(`expected ${api} near ${pkgFile}`);
    return mod;
};
const hasFns = (mod, keys) => !!mod &&
    typeof mod === 'object' &&
    keys.every((key) => typeof mod[key] === 'function');
export const loadModuleApi = (pkgFile, name, api, keys) => loadNear(pkgFile, name, api, (mod) => hasFns(mod, keys));
export const loadTypeScript = (pkgFile, api, check) => loadNear(pkgFile, 'typescript', api, check);
export const loadTypeScriptApi = (pkgFile, api, keys) => loadModuleApi(pkgFile, 'typescript', api, keys);
const workerOpts = (opts) => 
// `@types/node` rejects `type: 'module'` on eval workers; runtime supports it.
({
    eval: true,
    execArgv: opts.execArgv,
    stderr: opts.stderr,
    stdout: opts.stdout,
    type: 'module',
    workerData: opts.data,
});
export const runWorker = (code, opts) => new Promise((resolve) => {
    let worker;
    try {
        worker = new Worker(code, workerOpts(opts));
    }
    catch (error) {
        resolve(opts.error(error.message));
        return;
    }
    let done = false;
    let timer;
    const finish = (res, exited = false, force = false) => {
        if (done)
            return;
        done = true;
        if (timer)
            clearTimeout(timer);
        resolve(res);
        if ((force || opts.terminate !== false) && !exited)
            worker.terminate().catch(() => { });
    };
    if (opts.timeout)
        timer = setTimeout(() => finish(opts.timeout.result(), false, true), opts.timeout.ms);
    worker.once('message', (msg) => finish(msg));
    worker.once('error', (error) => finish(opts.error(error.message)));
    worker.once('exit', (code) => {
        if (done)
            return;
        finish(opts.error(code ? `worker exited with code ${code}` : 'worker exited without result'), true);
    });
});
export const runWorkerExec = (code, opts) => new Promise((resolve) => {
    const prev = opts.cwd ? process.cwd() : undefined;
    if (opts.cwd)
        process.chdir(opts.cwd);
    let done = false;
    let result;
    let stdout = '';
    let stderr = '';
    const finish = (res) => {
        if (done)
            return;
        done = true;
        if (prev)
            process.chdir(prev);
        resolve({ ...res, stderr, stdout });
    };
    let worker;
    const stop = async (res) => {
        try {
            const code = await worker.terminate();
            if (res.status === null)
                res.status = code;
        }
        catch { }
        finish(res);
    };
    try {
        worker = new Worker(code, workerOpts({ ...opts, stderr: true, stdout: true }));
    }
    catch (error) {
        finish({ error: error, ok: false, status: null, stderr: '', stdout: '' });
        return;
    }
    const out = worker.stdout;
    const err = worker.stderr;
    out?.setEncoding?.('utf8');
    err?.setEncoding?.('utf8');
    out?.on?.('data', (chunk) => (stdout += chunk));
    err?.on?.('data', (chunk) => (stderr += chunk));
    worker.once('message', (msg) => {
        result = msg;
        if (msg?.ok)
            return void stop({ ok: true, status: 0, stderr: '', stdout: '' });
        return void stop({ ok: false, status: 1, stderr: '', stdout: '' });
    });
    worker.once('error', (error) => void stop({ error, ok: false, status: null, stderr: '', stdout: '' }));
    worker.once('exit', (code) => {
        if (done)
            return;
        setImmediate(() => {
            if (done || result)
                return;
            finish({
                error: code === 0 ? undefined : new Error(`exit ${code}`),
                ok: code === 0,
                status: code,
                stderr: '',
                stdout: '',
            });
        });
    });
});
export const runImportFile = (file, opts = {}) => runWorkerExec(IMPORT_FILE_WORKER, {
    cwd: opts.cwd,
    data: { file: fileUrl(file) },
    execArgv: opts.execArgv,
});
let nextTemp = 0;
export const withTempFile = async (cwd, opts, fn) => {
    const file = join(cwd, `${opts.prefix}${process.pid}-${++nextTemp}.${opts.ext}`);
    write(file, opts.code);
    try {
        return await fn(file);
    }
    finally {
        rm(file);
    }
};
export const runTempImport = async (cwd, opts) => {
    return withTempFile(cwd, opts, (file) => runImportFile(file, { cwd, execArgv: opts.execArgv }));
};
export const paint = (text, code, on = true) => on ? `${code}${text}${color.reset}` : text;
export const wantColor = (env = process.env, tty = !!process.stderr.isTTY || !!process.stdout.isTTY) => {
    if (env.CLICOLOR_FORCE && env.CLICOLOR_FORCE !== '0')
        return true;
    if (env.FORCE_COLOR && env.FORCE_COLOR !== '0')
        return true;
    // Explicit force flags must win so one-shot debug runs can override a global NO_COLOR shell.
    if (env.NO_COLOR)
        return false;
    if (env.FORCE_COLOR === '0')
        return false;
    if (env.CLICOLOR === '0')
        return false;
    return tty;
};
export const status = (name, on) => {
    const code = name === 'error' ? color.red : name === 'warn' ? color.yellow : color.green;
    return `[${paint(name, code, on)}]`;
};
export const tag = (name, on) => {
    const code = name === 'ERROR' ? color.red : name === 'WARN' ? color.yellow : color.green;
    return `[${paint(name, code, on)}]`;
};
export const formatIssue = (level, head, ref, on) => `${tag(level, on)} ${head}: ${ref.file}:${ref.sym} ${ref.issue}`;
export const issueKind = (text, kind) => {
    const [first, ...rest] = text.split('\n');
    return [`${first} (${kind})`, ...rest].join('\n');
};
const issueLevel = (level) => level === 'error' ? 'ERROR' : level === 'warn' ? 'WARN' : level === 'info' ? 'INFO' : level;
export const makeIssue = (level, file, sym, text, kind = '') => ({
    level: issueLevel(level),
    ref: { file, issue: kind ? issueKind(text, kind) : text, sym },
});
export const countIssue = (res, issues, issue) => {
    if (issue.level === 'ERROR')
        res.failures += 1;
    else if (issue.level === 'WARN')
        res.warnings += 1;
    else
        res.skipped += 1;
    issues.push(issue);
};
export const recordIssue = (res, issues, level, file, sym, text, kind = '') => countIssue(res, issues, makeIssue(level, file, sym, text, kind));
export const sorted = (items) => [...items].sort();
const refLoc = (ref) => `${ref.file}:${ref.sym}`;
const action = (text, detail) => detail ? { detail, key: text, text } : { key: text, text };
const matchedAction = (issue, items) => {
    for (const [re, fn] of items) {
        const match = issue.match(re);
        if (!match)
            continue;
        const out = fn(match);
        if (out)
            return out;
    }
    // noImplicitReturns requires the no-match path to be explicit for this matcher helper.
    return undefined;
};
const refAction = (head, ref) => {
    if (head === 'bigint') {
        const [text, detail] = ref.issue.split('\n');
        if (detail)
            return action(text, detail);
    }
    if (head === 'bytes') {
        const hit = matchedAction(ref.issue, [
            [
                /^wrap (input|output) type with (TArg|TRet)<(.+)> \((bytes-(?:input|return))\)$/,
                ([, mode, name, type, kind]) => action(`wrap ${mode} type with ${name}<...> (${kind})`, `${name}<${type}>`),
            ],
            [
                /^wrap output type with Promise<TRet<(.+)>> \((bytes-return)\)$/,
                ([, type, kind]) => action(`wrap output type with Promise<TRet<...>> (${kind})`, `Promise<TRet<${type}>>`),
            ],
            [
                /^use Promise<TRet<(.+)>> instead of TRet<Promise<(.+)>> \((bytes-return)\)$/,
                ([, good, bad, kind]) => good === bad
                    ? action(`use Promise<TRet<...>> instead of TRet<Promise<...>> (${kind})`, `Promise<TRet<${good}>>`)
                    : undefined,
            ],
        ]);
        if (hit)
            return hit;
    }
    if (head === 'treeshake') {
        const hit = matchedAction(ref.issue, [
            [
                /^unused \((.+?)\)(?: \((treeshake)\))?$/,
                ([, detail, kind]) => action(`unused${kind ? ` (${kind})` : ''}`, `(${detail})`),
            ],
        ]);
        if (hit)
            return hit;
    }
    if (head === 'jsr') {
        const hit = matchedAction(ref.issue, [
            [
                /^(missing|fix) jsr export mapping; use (.+) -> (.+) \((jsr-export)\)$/,
                ([, mode, key, file, kind]) => action(`${mode} jsr export mapping (${kind})`, `${key} -> ${file}`),
            ],
            [
                /^remove unexpected jsr export mapping; drop (.+) -> (.+) \((jsr-export-extra)\)$/,
                ([, key, file, kind]) => action(`remove unexpected jsr export mapping (${kind})`, `${key} -> ${file}`),
            ],
            [
                /^fix jsr import mapping; use (.+) -> (.+) \((jsr-import)\)$/,
                ([, key, file, kind]) => action(`fix jsr import mapping (${kind})`, `${key} -> ${file}`),
            ],
            [
                /^remove unexpected jsr import mapping; drop (.+) -> (.+) \((jsr-import-extra)\)$/,
                ([, key, file, kind]) => action(`remove unexpected jsr import mapping (${kind})`, `${key} -> ${file}`),
            ],
            [
                new RegExp('^add (required publish entry|publish coverage for exported source graph); ' +
                    'use (.+) \\((jsr-publish(?:-required)?)\\)$'),
                ([, what, file, kind]) => action(`add ${what} (${kind})`, file),
            ],
            [
                /^remove non-source publish entry; drop (.+) \((jsr-publish-source)\)$/,
                ([, file, kind]) => action(`remove non-source publish entry (${kind})`, file),
            ],
        ]);
        if (hit)
            return hit;
    }
    return action(ref.issue);
};
const formatIssueGroup = (level, head, issue, refs, on) => refs.length === 1 && (head === 'errors' || !refs[0].detail)
    ? [formatIssue(level, head, refs[0].ref, on)]
    : [
        `${tag(level, on)} ${head}: ${refs.length === 1 ? issue : `${refs.length}x ${issue}`}`,
        ...refs.map((item) => `  ${refLoc(item.ref)}${item.detail ? ` ${item.detail}` : ''}`),
    ];
export const groupIssues = (head, issues, on) => {
    const grouped = new Map();
    for (const item of issues) {
        const action = refAction(head, item.ref);
        const key = `${item.level}\0${action.key}`;
        const prev = grouped.get(key);
        const ref = { detail: action.detail, ref: item.ref };
        if (prev)
            prev.refs.push(ref);
        else
            grouped.set(key, { issue: action.text, level: item.level, refs: [ref] });
    }
    return [...grouped.values()].flatMap((item) => formatIssueGroup(item.level, head, item.issue, item.refs, on));
};
export const printIssues = (head, issues, on) => {
    for (const line of groupIssues(head, issues, on))
        console.error(line);
};
export const summary = (res) => [
    `${res.passed} passed`,
    `${res.warnings} warning${res.warnings === 1 ? '' : 's'}`,
    `${res.failures} failure${res.failures === 1 ? '' : 's'}`,
    `${res.skipped} skipped`,
].join(', ');
export const collectIssues = (items, scan, ref) => {
    const result = emptyResult();
    const issues = [];
    for (const item of items) {
        const hits = scan(item);
        if (!hits.length) {
            result.passed++;
            continue;
        }
        for (const hit of hits)
            issues.push(ref(hit));
        result.failures += hits.length;
    }
    return { issues, result };
};
export const reportIssues = (head, issues, res, on, fail, warn = 'pass') => {
    printIssues(head, issues, on);
    if (res.failures) {
        console.error(`${status('error', on)} summary: ${summary(res)}`);
        throw new Error(fail);
    }
    if (res.warnings && (warn === 'error' || warn === 'fail')) {
        console.error(`${status(warn === 'error' ? 'error' : 'warn', on)} summary: ${summary(res)}`);
        throw new Error(fail);
    }
    if (res.warnings && warn === 'warn')
        return console.error(`${status('warn', on)} summary: ${summary(res)}`);
    console.log(`${status('pass', on)} summary: ${summary(res)}`);
};
export const guardChild = (cwd, file, label) => {
    const rel = relative(cwd, file);
    if (!rel || rel === '.' || rel.startsWith('..') || isAbsolute(rel))
        throw new Error(`refusing unsafe ${label} path ${file}; expected a child path of ${cwd}`);
};
export const pkgTarget = (pkgArg, cwd = process.cwd()) => {
    const base = resolve(cwd);
    const pkgFile = resolve(base, pkgArg);
    guardChild(base, pkgFile, 'package');
    return { cwd: base, pkgFile };
};
export const wantTSFile = (file) => {
    if (!TS.has(file.slice(file.lastIndexOf('.'))))
        return false;
    if (/\.d\.[cm]?ts$/.test(file))
        return false;
    return true;
};
export const resolveLocalImport = (from, spec, opts) => {
    if (!spec.startsWith('.'))
        return;
    const raw = resolve(dirname(from), spec);
    const exts = opts.exts || TS_IMPORT_EXTS;
    const indexExts = opts.indexExts || exts;
    const tries = [
        raw,
        ...exts.map((ext) => `${raw}${ext}`),
        ...indexExts.map((ext) => join(raw, `index${ext}`)),
    ];
    if (opts.jsToTs !== false && /\.[cm]?js$/.test(raw)) {
        tries.push(raw.replace(/\.js$/, '.ts'), raw.replace(/\.js$/, '.mts'), raw.replace(/\.js$/, '.cts'), raw.replace(/\.mjs$/, '.mts'), raw.replace(/\.cjs$/, '.cts'));
    }
    for (const file of tries)
        if (opts.accept(file))
            return file;
    return;
};
const listTSFiles = (dir) => dirEntries(dir).flatMap((ent) => {
    const file = join(dir, ent.name);
    if (ent.isDirectory())
        return listTSFiles(file);
    return wantTSFile(file) ? [file] : [];
});
export const pickTSFiles = (cwd) => {
    const root = dirEntries(cwd).flatMap((ent) => {
        const file = join(cwd, ent.name);
        if (!ent.isFile())
            return [];
        return wantTSFile(file) ? [file] : [];
    });
    const src = join(cwd, 'src');
    const files = existsSync(src) ? [...root, ...listTSFiles(src)] : root;
    if (!files.length)
        throw new Error(`expected root *.ts files or src/*.ts files next to ${basename(cwd)}`);
    return files;
};
export const sourceCtx = (pkgArg, cwd = process.cwd()) => {
    const target = pkgTarget(pkgArg, cwd);
    return { cwd: target.cwd, files: pickTSFiles(target.cwd), pkgFile: target.pkgFile };
};
