#!/usr/bin/env -S node
/**
Checks package test and benchmark entry scripts.
Goal:
  - catch broken test/benchmark imports and immediate crashes before a full human review run
  - treat scripts that survive until timeout as OK because the smoke check only targets startup failure
Rules:
  - run direct `test/*.test.ts`, `test/benchmark/*.ts`, and `benchmark/*.ts` files
  - skip underscore-prefixed benchmark helpers because they are usually imported, not executed
  - run test files from the package root and benchmark files from their benchmark directory
  - execute scripts in parallel with a small worker limit and a per-file timeout
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { cliArgs, collectIssues, dirEntries, jsbtWorkerLimit, makeIssue, pkgTarget, readText, reportIssues, runSelf, textLines, usageText, wantTSFile, } from "./utils.js";
const usage = usageText('tests', 'check-tests.ts');
const LIMIT = 8;
const TIMEOUT = 10_000;
const MAX_OUTPUT = 8192;
const NODE_ARGS = ['--disable-warning=ExperimentalWarning'];
const resolvePkg = (args, cwd = process.cwd()) => {
    const { pkgFile } = pkgTarget(args.pkgArg, cwd);
    readText(pkgFile);
    return { cwd: dirname(pkgFile), pkgFile };
};
const keep = (prev, chunk) => {
    const next = prev + chunk.toString('utf8');
    return next.length > MAX_OUTPUT ? next.slice(next.length - MAX_OUTPUT) : next;
};
const messageLine = (text) => {
    const lines = textLines(text);
    // Node ESM stack traces usually print the source location before the actual Error line.
    return lines.find((line) => /^[A-Za-z]*Error\b/.test(line)) || lines[0] || '';
};
const listDir = (cwd, relDir, kind) => {
    const dir = join(cwd, relDir);
    if (!existsSync(dir))
        return [];
    return dirEntries(dir).flatMap((ent) => {
        if (!ent.isFile())
            return [];
        const file = join(dir, ent.name);
        if (!wantTSFile(file))
            return [];
        if (kind === 'test' && !ent.name.endsWith('.test.ts'))
            return [];
        if (kind === 'benchmark' && ent.name.startsWith('_'))
            return [];
        return [{ cwd: kind === 'benchmark' ? dir : cwd, file, kind, rel: relative(cwd, file) }];
    });
};
const list = (cwd) => [
    ...listDir(cwd, 'test', 'test'),
    ...listDir(cwd, 'test/benchmark', 'benchmark'),
    ...listDir(cwd, 'benchmark', 'benchmark'),
].sort((a, b) => a.rel.localeCompare(b.rel));
const runOne = (item, timeoutMs) => new Promise((resolve) => {
    const child = spawn(process.execPath, [...NODE_ARGS, item.file], {
        cwd: item.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let done = false;
    let stderr = '';
    let stdout = '';
    let timeout = false;
    const timer = setTimeout(() => {
        timeout = true;
        child.kill('SIGKILL');
    }, timeoutMs);
    const finish = (res) => {
        if (done)
            return;
        done = true;
        clearTimeout(timer);
        resolve(res);
    };
    child.stdout.on('data', (chunk) => {
        stdout = keep(stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
        stderr = keep(stderr, chunk);
    });
    child.once('error', (error) => finish({ error: error.message, stderr, stdout }));
    child.once('close', (code, signal) => finish({
        code: code === null ? undefined : code,
        signal: signal || undefined,
        stderr,
        stdout,
        timeout,
    }));
});
const runLimit = async (items, limit, fn) => {
    const out = new Array(items.length);
    let pos = 0;
    const worker = async () => {
        for (;;) {
            const i = pos++;
            if (i >= items.length)
                return;
            const item = items[i];
            out[i] = { ...item, ...(await fn(item)) };
        }
    };
    const n = Math.min(Math.max(1, limit), items.length);
    await Promise.all(Array.from({ length: n }, worker));
    return out;
};
const issue = (row) => {
    const note = messageLine(row.stderr) || messageLine(row.stdout);
    if (row.timeout)
        return undefined;
    if (row.error)
        return { detail: row.error, sym: 'exec' };
    if (row.code && row.code !== 0)
        return { detail: `exited ${row.code}${note ? ` ${note}` : ''}`, sym: 'exec' };
    if (row.signal)
        return { detail: `terminated by signal ${row.signal}${note ? ` ${note}` : ''}`, sym: 'exec' };
    return undefined;
};
export const runCli = async (argv, opts = {}) => {
    const cli = cliArgs(argv, usage, opts.color);
    if (!cli)
        return;
    const { args, colorOn } = cli;
    const ctx = resolvePkg(args, opts.cwd);
    const timeoutMs = opts.timeoutMs || TIMEOUT;
    const rows = await runLimit(list(ctx.cwd), opts.limit || jsbtWorkerLimit(LIMIT), (item) => runOne(item, timeoutMs));
    const { issues, result } = collectIssues(rows, (row) => {
        const bad = issue(row);
        return bad ? [{ bad, row }] : [];
    }, (item) => makeIssue('error', item.row.rel, item.bad.sym, item.bad.detail, 'tests'));
    reportIssues('tests', issues, result, colorOn, 'Tests check found issues');
};
runSelf(import.meta.url, runCli);
