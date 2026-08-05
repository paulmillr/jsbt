#!/usr/bin/env -S node
/**
Checks public declaration files for local `import("./x").Type` references.
Goal:
  - keep published type surfaces readable without inline local import-type chains
Rules:
  - scan public `.d.ts` / `.d.mts` files only
  - report local relative `import("./x").Type` references
  - fix them with a local `import type { Foo } from './x.ts'; export type { Foo };`
  - direct `export type { Foo } from './x.ts'` does not create a local binding for signatures
  - runtime `await import(...)` and package/builtin import types are out of scope
 */
import { listModules, publicCtx } from "./public.js";
import { cliArgs, collectIssues, importTypeText, loadTypeScriptApi, makeIssue, nodeLine, readSource, relName, reportIssues, runSelf, usageText, walkAst, } from "./utils.js";
const usage = usageText('typeimport', 'check-typeimport.ts');
const loadTS = (pkgFile) => {
    return loadTypeScriptApi(pkgFile, 'TypeScript parser API', ['createSourceFile']);
};
const importTypeName = (source, node) => (node.qualifier ? node.qualifier.getText(source) : 'import');
const typeIssue = (name, spec) => `add import type { ${name} } from '${spec}'; export type { ${name} }; to avoid import(...) in public types`;
const scan = (ts, cwd, file) => {
    const { source } = readSource(ts, file);
    const out = [];
    const seen = new Set();
    walkAst(ts, source, (node) => {
        if (ts.isImportTypeNode(node) && !node.isTypeOf) {
            const spec = importTypeText(ts, node);
            if (spec.startsWith('.')) {
                const line = nodeLine(source, node);
                const name = importTypeName(source, node);
                const key = `${name}\0${spec}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    out.push({ file: relName(cwd, file), line, name, spec });
                }
            }
        }
    });
    return out;
};
export const runCli = async (argv, opts = {}) => {
    const cli = cliArgs(argv, usage, opts.color);
    if (!cli)
        return;
    const { args, colorOn } = cli;
    const ctx = publicCtx(args.pkgArg, opts.cwd);
    const { cwd, pkgFile } = ctx;
    const ts = loadTS(pkgFile);
    const { issues, result } = collectIssues(listModules(ctx), (mod) => scan(ts, cwd, mod.dtsFile), (item) => makeIssue('error', item.file, `${item.line}/typeimport`, typeIssue(item.name, item.spec), 'typeimport'));
    reportIssues('typeimport', issues, result, colorOn, 'Type import check found issues');
};
runSelf(import.meta.url, runCli);
