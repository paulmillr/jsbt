// Destructive ops and `npm install` SHOULD use only `fs-modify.ts`; do not call `rmSync`, `rmdirSync`,
// `unlinkSync`, `writeFileSync`, or raw `npm install` directly here.
/**
 * `jsbt` dispatches the shared build and audit helpers shipped by `@paulmillr/jsbt`.
 *
 * Usage:
 *   `jsbt bundle`
 *   `jsbt check`
 *   `jsbt check --project=directory`
 *   `jsbt check bigint`
 *   `jsbt check bytes`
 *   `jsbt check comments`
 *   `jsbt check errors`
 *   `jsbt check importtime`
 *   `jsbt check jsdoc`
 *   `jsbt check jsr`
 *   `jsbt check jsrpublish`
 *   `jsbt check mutate`
 *   `jsbt check patterns`
 *   `jsbt check readme`
 *   `jsbt check treeshake`
 *   `jsbt check tsdoc`
 *   `jsbt check typeimport`
 *   `jsbt check-install package.json`
 * @module
 */
import * as TSDoc from '@microsoft/tsdoc';
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { checkTempDir, rmCheckTempDir } from "../fs-modify.js";
import { runCli as runBigInt } from "./bigint.js";
import { runCli as runBuild } from "./bundle.js";
import { runCli as runBytes } from "./bytes.js";
import { runCli as runCheckInstall } from "./check-install.js";
import { runCli as runComments } from "./comments.js";
import { runCli as runErrors } from "./errors.js";
import { runCli as runImportTime } from "./importtime.js";
import { runCli as runTSDoc } from "./jsdoc.js";
import { runCli as runJsr } from "./jsr.js";
import { runCli as runJsrPublish } from "./jsrpublish.js";
import { runCli as runMutate } from "./mutate.js";
import { runCli as runPatterns } from "./patterns.js";
import { runCli as runReadme } from "./readme.js";
import { runCli as runTreeShaking, treeIssueLog } from "./treeshake.js";
import { runCli as runTypeImport } from "./typeimport.js";
import { color, defaultFast, err, fastWorkerCount, formatIssue, groupIssues, paint, runWorker, tag as statusTag, stripAnsi, textLines, wantColor, withSourceFileCache, } from "./utils.js";
const usage = `usage:
  jsbt bundle [--dir=<build-dir>] [--no-prefix] [--stats]
  jsbt check [--project=<directory>]
  jsbt check [--project=<directory>] bigint
  jsbt check [--project=<directory>] bytes
  jsbt check [--project=<directory>] comments
  jsbt check [--project=<directory>] errors
  jsbt check [--project=<directory>] importtime
  jsbt check [--project=<directory>] jsdoc
  jsbt check [--project=<directory>] jsr
  jsbt check [--project=<directory>] jsrpublish
  jsbt check [--project=<directory>] mutate
  jsbt check [--project=<directory>] patterns
  jsbt check [--project=<directory>] readme
  jsbt check [--project=<directory>] treeshake
  jsbt check [--project=<directory>] tsdoc
  jsbt check [--project=<directory>] typeimport
  jsbt check-install <package.json>

examples:
  npx --no @paulmillr/jsbt bundle
  npx --no @paulmillr/jsbt check
  npx --no @paulmillr/jsbt check --project=packages/pkg-a
  npm run check bigint
  npx --no @paulmillr/jsbt check treeshake`;
const CHECK_OUT = 'test/build/out-treeshake';
const CHECK_WORKER = 'jsbt-check-worker';
const WORKER = `import { workerData } from 'node:worker_threads';
process.argv[1] = workerData.entry;
await import(workerData.self);`;
const QUIET_ENV = {
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_loglevel: 'silent',
    npm_config_progress: 'false',
    npm_config_update_notifier: 'false',
};
const MUTATION_LOG = /^(?:delete\t|install\t|write\t)/;
const NPM_INSTALL_FAIL = /^Command failed: npm install(?:\s|$)/;
const CHECK_ALIASES = {
    bigint: 'bigint',
    bytes: 'bytes',
    comments: 'comments',
    errors: 'errors',
    importtime: 'importtime',
    jsdoc: 'tsdoc',
    jsr: 'jsr',
    jsrpublish: 'jsrpublish',
    mutate: 'mutate',
    patterns: 'patterns',
    readme: 'readme',
    treeshake: 'treeshake',
    typeimport: 'typeimport',
    tsdoc: 'tsdoc',
};
const HARD_ERROR_CHECKS = new Set(['jsr', 'jsrpublish']);
const issueLines = (text) => {
    const out = [];
    let prev;
    for (const line of textLines(text, true)) {
        const plain = stripAnsi(line);
        if (/^\[(?:error|warn|ERROR|WARN)\]\s/.test(plain)) {
            prev = plain.includes('summary:') ? undefined : { cont: [], line, plain };
            if (prev)
                out.push(prev);
            continue;
        }
        // Some subchecks print actionable continuation lines, e.g. canonical helper snippets.
        if (prev)
            prev.cont.push(line);
    }
    return out;
};
const recolorShared = (line, level, on) => line.replace(/^\[(?:ERROR|WARN|INFO)\]/, statusTag(level, on));
const downgradeErrorLine = (line, on) => line.replace(/^\[(?:\x1b\[\d+(?:;\d+)*m)?ERROR(?:\x1b\[0m)?\]/, statusTag('WARN', on));
const checkPick = (head, out, on) => HARD_ERROR_CHECKS.has(head) || out.hard
    ? out
    : { ...out, fatal: false, lines: out.lines.map((line) => downgradeErrorLine(line, on)) };
const sharedIssues = (head, text, on) => {
    let cur = false;
    const out = [];
    let count = 0;
    let fatal = false;
    for (const line of textLines(text, true)) {
        const plain = stripAnsi(line);
        const tag = plain.match(/^\[(ERROR|WARN|INFO)\] (\w+): (.+)$/);
        if (tag && tag[2] === head) {
            cur = true;
            out.push(recolorShared(line, tag[1], on));
            count += Number(tag[3].match(/^(\d+)x /)?.[1] || 1);
            if (tag[1] === 'ERROR')
                fatal = true;
            continue;
        }
        if (cur && !/^\[(?:error|warn|pass|ERROR|WARN|INFO)\]\s/.test(plain)) {
            out.push(line);
            continue;
        }
        cur = false;
    }
    return out.length ? { count, fatal, lines: out } : undefined;
};
const duration = (ms) => {
    const total = Math.max(0, Math.round(ms / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    const parts = [];
    if (hours)
        parts.push(`${hours}h`);
    if (hours || minutes)
        parts.push(`${minutes}min`);
    parts.push(`${seconds}s`);
    return parts.join(' ');
};
const secondsDuration = (ms) => `${Math.max(0, Math.round(ms / 1000))} sec`;
const SLOW_CHECK_MS = 10_000;
const slowCheckStats = (items, on) => {
    const slow = items.filter((item) => item.ms > SLOW_CHECK_MS);
    if (!slow.length)
        return '';
    const stats = slow.map((item) => `${item.head} (${duration(item.ms)})`).join(', ');
    return `. ${paint(`Slow checks: ${stats}.`, color.yellow, on)}`;
};
const checkDone = (total, ms, on, stats = []) => {
    const count = paint(String(total), color.green, on);
    const noun = `check${total === 1 ? '' : 's'}`;
    const base = `${count} ${noun} finished in ${secondsDuration(ms)}`;
    return `${base}${slowCheckStats(stats, on)}`;
};
const checkFastWorkers = () => {
    const fast = defaultFast();
    return fast ? fastWorkerCount(fast) : 0;
};
const checkQuiet = () => {
    const value = process.env.JSBT_QUIET;
    return value === '1' || value === 'true';
};
const checkHeader = (total, on, quiet) => {
    const env = paint(`(JSBT_QUIET=${quiet ? 1 : 0}, JSBT_FAST=${checkFastWorkers()})`, color.gray, on);
    return `${paint(String(total), color.green, on)} check${total === 1 ? '' : 's'} started ${env}`;
};
const checkDot = (fail) => {
    const out = fail ? process.stderr : process.stdout;
    out.write(fail ? '!' : '.');
};
const timed = async (fn) => {
    const start = Date.now();
    const res = await fn();
    return { ...res, ms: Date.now() - start };
};
const untag = (line) => line.replace(/^\[(?:error|pass|warn|ERROR|WARN|INFO)\]\s*/, '').replace(/^\([^)]+\)\s*/, '');
const parseRef = (msg) => {
    const hit = msg.match(/^(.+?):(.+?) \((\d+)\): (.+)$/);
    if (hit) {
        const [, file, section, line, issue] = hit;
        const sym = section ? `${line}/${section}` : line;
        return { file, issue, sym };
    }
    const simple = msg.match(/^(.+?):(.+?): (.+)$/);
    if (simple) {
        const [, file, section, issue] = simple;
        return { file, issue, sym: section };
    }
    const shared = msg.match(/^(.+?):(\S+) (.+)$/);
    if (!shared)
        return;
    const [, file, section, issue] = shared;
    return { file, issue, sym: section };
};
const withQuiet = async (fn) => {
    const prev = new Map();
    for (const [key, value] of Object.entries(QUIET_ENV)) {
        prev.set(key, process.env[key]);
        process.env[key] = value;
    }
    try {
        return await fn();
    }
    finally {
        for (const [key, value] of prev) {
            if (value === undefined)
                delete process.env[key];
            else
                process.env[key] = value;
        }
    }
};
const capture = async (fn) => {
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
    }
    catch (error) {
        return { error: error.message, ok: false, stderr, stdout };
    }
    finally {
        console.log = prevLog;
        console.error = prevErr;
    }
};
const pickIssues = (head, res, on) => {
    const grouped = sharedIssues(head, res.stderr, on);
    if (grouped)
        return { ...grouped, fatal: grouped.fatal || !res.ok };
    let fatal = !res.ok;
    const issues = issueLines(res.stderr).map((item) => {
        const msg = untag(item.plain);
        const level = /^\[(?:warn|WARN)\]\s/.test(item.plain) ? 'WARN' : 'ERROR';
        if (level === 'ERROR')
            fatal = true;
        const ref = parseRef(msg);
        if (ref && item.cont.length)
            ref.issue += `\n${item.cont.join('\n')}`;
        return { level, ref: ref || { file: 'unknown', issue: msg, sym: '0' } };
    });
    if (issues.length || !res.error)
        return { count: issues.length, fatal, lines: groupIssues(head, issues, on) };
    return {
        count: 1,
        fatal: true,
        hard: res.hard,
        lines: [formatIssue('ERROR', head, { file: 'unknown', issue: res.error, sym: '0' }, on)],
    };
};
const resultSummary = (text) => {
    const match = text.match(/summary: \d+ passed, (\d+) warnings?, (\d+) failures?, \d+ skipped/);
    return match ? { failures: Number(match[2]), warnings: Number(match[1]) } : undefined;
};
const pickErrors = (res, on) => {
    const out = pickIssues('errors', res, on);
    const resSum = resultSummary(`${res.stderr}\n${res.stdout}`);
    if (!resSum)
        return out;
    const sentinel = out.count === 1 &&
        out.lines.length === 1 &&
        stripAnsi(out.lines[0]).includes('unknown:0 Errors check found issues');
    // errors audit rows carry accepted wrong values as stdout evidence, not `[ERROR]` issue lines.
    const count = Math.max(sentinel ? 0 : out.count, resSum.failures + resSum.warnings);
    return {
        ...out,
        count,
        fatal: (sentinel ? false : out.fatal) || !!resSum.failures,
        lines: sentinel ? [] : out.lines,
    };
};
const pickErrorExamples = (res, on) => {
    const issues = [];
    for (const item of issueLines(res.stderr)) {
        if (!item.plain.includes('(errors-example)'))
            continue;
        if (!item.plain.includes('could not derive valid runtime probes'))
            continue;
        const ref = parseRef(untag(item.plain));
        issues.push({
            level: 'WARN',
            ref: ref || { file: 'unknown', issue: untag(item.plain), sym: '0' },
        });
    }
    return { count: issues.length, fatal: false, lines: groupIssues('errors', issues, on) };
};
const pickLogs = (head, res, full = false) => textLines(res.stdout, full).filter((line) => full || head === 'errors' || MUTATION_LOG.test(line));
const warnInfoLine = (line) => /^\[(?:WARN|INFO)\]/.test(stripAnsi(line));
const checkHead = (name) => name && Object.hasOwn(CHECK_ALIASES, name)
    ? CHECK_ALIASES[name]
    : undefined;
const checkArgs = (argv) => {
    if (argv.includes('--help') || argv.includes('-h'))
        return { head: undefined, help: true, outArg: '', pkgArg: '', projectArg: '.' };
    const rest = [];
    let projectArg = '.';
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--project') {
            const value = argv[++i];
            if (!value)
                err('expected directory after --project');
            projectArg = value;
            continue;
        }
        if (arg.startsWith('--project=')) {
            projectArg = arg.slice('--project='.length);
            if (!projectArg)
                err('expected directory after --project=');
            continue;
        }
        if (arg.startsWith('-'))
            err(`unknown check option: ${arg}`);
        rest.push(arg);
    }
    if (rest.some((arg) => arg === 'package.json' || /[/\\]package\.json$/.test(arg)))
        err('package.json positional argument was removed; use jsbt check or jsbt check --project=<directory>');
    if (rest.length > 1)
        err('expected [--project=<directory>] [check-name]');
    const head = checkHead(rest[0]);
    if (head)
        return { head, help: false, outArg: CHECK_OUT, pkgArg: 'package.json', projectArg };
    if (rest[0] === 'tests')
        err(`unknown check selector: ${rest[0]}`);
    if (rest[0]?.startsWith('check-'))
        err(`unknown check selector: ${rest[0]}`);
    if (rest[0])
        err(`unknown check selector: ${rest[0]}`);
    return {
        head: undefined,
        help: false,
        outArg: CHECK_OUT,
        pkgArg: 'package.json',
        projectArg,
    };
};
const checkTasks = {
    bigint: (args, opts) => runBigInt([args.pkgArg], opts),
    bytes: (args, opts) => runBytes([args.pkgArg], opts),
    comments: (args, opts) => runComments([args.pkgArg], opts),
    errors: (args, opts) => runErrors([args.pkgArg], {
        color: opts.color,
        cwd: opts.cwd,
        examplesOnly: !args.head,
        runDir: opts.runDir,
    }),
    importtime: (args, opts) => runImportTime([args.pkgArg], { color: opts.color, cwd: opts.cwd, quiet: true }),
    jsr: (args, opts) => runJsr([args.pkgArg], opts),
    jsrpublish: (args, opts) => (opts.runJsrPublish || runJsrPublish)([args.pkgArg], {
        color: opts.color,
        cwd: opts.cwd,
        full: !!args.head,
    }),
    mutate: (args, opts) => runMutate([args.pkgArg], opts),
    patterns: (args, opts) => runPatterns([args.pkgArg], opts),
    readme: (args, opts) => runReadme([args.pkgArg], { color: opts.color, cwd: opts.cwd, runDir: opts.runDir }),
    treeshake: (args, opts, tree) => runTreeShaking([args.pkgArg, args.outArg], {
        cwd: opts.cwd,
        onIssue: (issue) => tree.push(issue),
        outDir: opts.treeshakeOutDir,
        quiet: !args.head,
        runDir: opts.runDir,
    }),
    tsdoc: (args, opts) => runTSDoc([args.pkgArg], {
        color: opts.color,
        cwd: opts.cwd,
        loadTSDoc: () => TSDoc,
        runDir: opts.runDir,
    }),
    typeimport: (args, opts) => runTypeImport([args.pkgArg], opts),
};
const runCheckTask = async (head, args, opts) => {
    const tree = [];
    const res = await withQuiet(() => capture(() => checkTasks[head](args, opts, tree)));
    if (tree.length)
        res.tree = tree;
    else if (res.error && NPM_INSTALL_FAIL.test(res.error))
        res.hard = true;
    else if (head === 'treeshake' && !res.ok)
        res.hard = true;
    return res;
};
const runCheckTaskTimed = (head, args, opts) => timed(() => runCheckTask(head, args, opts));
const runWorkerMain = async () => {
    const data = workerData;
    try {
        if (data.heads) {
            const out = await withSourceFileCache(async () => {
                const captures = [];
                for (const head of data.heads)
                    captures.push(await runCheckTaskTimed(head, data.args, data.opts));
                return captures;
            });
            parentPort?.postMessage(out);
            return;
        }
        if (!data.head)
            throw new Error('missing check worker head');
        parentPort?.postMessage(await runCheckTask(data.head, data.args, data.opts));
    }
    catch (error) {
        const res = {
            error: error.message,
            ok: false,
            stderr: '',
            stdout: '',
        };
        parentPort?.postMessage(data.heads ? data.heads.map(() => ({ ...res, ms: 0 })) : res);
    }
};
const runCheckWorker = (head, args, opts) => 
// Workers isolate console/env capture for independent checks. npm-installing example checks
// share test/build and use process.chdir(), so runCheck keeps them on one main-thread lane.
runWorker(WORKER, {
    data: {
        args,
        entry: fileURLToPath(import.meta.url),
        head,
        kind: CHECK_WORKER,
        opts: {
            color: opts.color,
            cwd: opts.cwd,
            runDir: opts.runDir,
            treeshakeOutDir: opts.treeshakeOutDir,
        },
        self: import.meta.url,
    },
    error: (error) => ({ error, ok: false, stderr: '', stdout: '' }),
});
const runCheck = async (argv, opts = {}) => {
    const args = checkArgs(argv);
    if (args.help)
        return console.log(usage);
    const checkTmp = checkTempDir();
    try {
        const projectCwd = resolve(opts.cwd || process.cwd(), args.projectArg);
        const taskOpts = {
            ...opts,
            cwd: projectCwd,
            runDir: join(checkTmp, 'build'),
            treeshakeOutDir: join(checkTmp, 'out-treeshake'),
        };
        const colorOn = opts.color ?? wantColor();
        const quiet = checkQuiet();
        const progressStart = (head) => {
            if (!quiet)
                console.log(`☆ ${head}`);
        };
        const progressDone = (head, ok, ms) => {
            if (quiet)
                return checkDot(!ok);
            const spent = ms >= 5_000 ? ` ${duration(ms)}` : '';
            console.log(paint(`${ok ? '✓' : '☓'} ${head}${spent}`, ok ? color.green : color.red, colorOn));
        };
        const totalStart = Date.now();
        let hasFail = false;
        const check = (head, serial) => ({
            head,
            pick: (res) => head === 'errors'
                ? args.head
                    ? pickErrors(res, colorOn)
                    : pickErrorExamples(res, colorOn)
                : pickIssues(head, res, colorOn),
            serial,
        });
        const allChecks = [
            check('readme', true),
            {
                head: 'treeshake',
                pick: (res) => {
                    const issues = (res.tree || []).map((item) => treeIssueLog(taskOpts.cwd, item));
                    if (issues.length || !res.error) {
                        return {
                            count: issues.length,
                            fatal: !!issues.length,
                            lines: groupIssues('treeshake', issues, colorOn),
                        };
                    }
                    return {
                        count: 1,
                        fatal: true,
                        hard: true,
                        lines: [
                            formatIssue('ERROR', 'treeshake', { file: 'unknown', issue: res.error, sym: '0' }, colorOn),
                        ],
                    };
                },
                serial: true,
            },
            check('tsdoc', true),
            check('typeimport'),
            check('jsr'),
            check('jsrpublish', true),
            check('comments'),
            check('patterns'),
            check('errors', true),
            check('bigint'),
            check('bytes'),
            check('mutate'),
            {
                head: 'importtime',
                pick: (res) => pickIssues('importtime', res, colorOn),
                // Keep this policy explicit: the regression test source-scans it because timing is fragile.
                serial: true,
            },
        ];
        const list = args.head
            ? allChecks.filter((item) => item.head === args.head)
            : allChecks.filter((item) => item.head !== 'patterns');
        console.log(checkHeader(list.length, colorOn, quiet));
        if (!quiet)
            console.log();
        const res = [];
        const save = async (i, head, fn) => {
            progressStart(head);
            res[i] = await timed(fn);
            progressDone(head, HARD_ERROR_CHECKS.has(head) || res[i].hard ? res[i].ok : true, res[i].ms);
        };
        const workers = checkFastWorkers();
        const saveParallel = async (jobs) => {
            if (workers < 2 || jobs.length < 2) {
                for (const { i, item } of jobs)
                    await save(i, item.head, () => runCheckWorker(item.head, args, taskOpts));
                return;
            }
            if (!quiet)
                for (const { item } of jobs)
                    progressStart(item.head);
            let next = 0;
            await Promise.all(Array.from({ length: Math.min(workers, jobs.length) }, async () => {
                for (;;) {
                    const job = jobs[next++];
                    if (!job)
                        return;
                    res[job.i] = await timed(() => runCheckWorker(job.item.head, args, taskOpts));
                }
            }));
            for (const { i, item } of jobs)
                progressDone(item.head, HARD_ERROR_CHECKS.has(item.head) || res[i].hard ? res[i].ok : true, res[i].ms);
        };
        for (let i = 0; i < list.length;) {
            const item = list[i];
            if (item.serial) {
                await save(i++, item.head, () => runCheckTask(item.head, args, taskOpts));
                continue;
            }
            const jobs = [];
            while (i < list.length && !list[i].serial) {
                jobs.push({ i, item: list[i] });
                i++;
            }
            await saveParallel(jobs);
        }
        if (!quiet)
            console.log();
        const totalMs = Date.now() - totalStart;
        let diagnosticGap = false;
        const printDiagnostic = (line, log) => {
            if (!diagnosticGap && warnInfoLine(line)) {
                log();
                diagnosticGap = true;
            }
            log(line);
        };
        for (let i = 0; i < list.length; i++) {
            const item = list[i];
            const cur = res[i];
            const out = checkPick(item.head, item.pick(cur), colorOn);
            if (out.fatal)
                hasFail = true;
            if (quiet && !out.fatal)
                continue;
            if (item.head === 'errors') {
                for (const line of out.lines)
                    printDiagnostic(line, console.error);
                if (args.head)
                    for (const line of pickLogs(item.head, cur))
                        printDiagnostic(line, console.log);
            }
            else {
                const full = !!args.head && item.head === 'treeshake';
                for (const line of pickLogs(item.head, cur, full))
                    printDiagnostic(line, console.log);
                for (const line of out.lines)
                    printDiagnostic(line, console.error);
            }
        }
        const stats = list.map((item, i) => ({ head: item.head, ms: res[i].ms }));
        const done = checkDone(list.length, totalMs, colorOn, stats);
        if (hasFail) {
            console.error();
            throw new Error(done);
        }
        console.log();
        console.log(done);
    }
    finally {
        rmCheckTempDir(checkTmp);
    }
};
const cmdRun = {
    check: runCheck,
    'check-install': (argv, opts) => runCheckInstall(argv, { cwd: opts.cwd }),
    bundle: runBuild,
};
const COMMANDS = new Set(Object.keys(cmdRun));
const cmd = (name) => COMMANDS.has(name) ? name : undefined;
export const runCli = async (argv, opts = {}) => {
    const [head, ...rest] = argv;
    if (!head || head === '--help' || head === '-h')
        return console.log(usage);
    const sub = cmd(head);
    if (!sub)
        throw new Error(`unknown jsbt command: ${head}\n\n${usage}`);
    return cmdRun[sub](rest, opts);
};
const main = async () => {
    try {
        await runCli(process.argv.slice(2));
    }
    catch (err) {
        console.error(err.message);
        process.exitCode = 1;
    }
};
const entry = process.argv[1];
const self = fileURLToPath(import.meta.url);
const data = workerData;
if (!isMainThread && data?.kind === CHECK_WORKER)
    await runWorkerMain();
else if (isMainThread && entry && realpathSync(resolve(entry)) === realpathSync(self))
    await main();
