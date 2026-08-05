import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { err, pkgTarget, readJson, relName } from "./utils.js";
export const readPkg = (pkgFile) => {
    const raw = readJson(pkgFile);
    if (typeof raw.name !== 'string' || !raw.name)
        err(`missing name in ${pkgFile}`);
    let exports = raw.exports;
    let self = true;
    if (!exports || typeof exports !== 'object') {
        const entry = typeof raw.module === 'string' ? raw.module : typeof raw.main === 'string' ? raw.main : '';
        if (!entry)
            err(`missing exports or main/module entry in ${pkgFile}`);
        exports = { '.': entry };
        self = false;
    }
    return {
        exports: exports,
        name: raw.name,
        self,
        types: typeof raw.types === 'string' ? raw.types : '',
    };
};
// Exported helpers need explicit annotations for isolated declaration emit.
export const publicCtx = (pkgArg, cwd = process.cwd()) => {
    const { pkgFile } = pkgTarget(pkgArg, cwd);
    const root = dirname(pkgFile);
    return { cwd: root, pkg: readPkg(pkgFile), pkgFile };
};
const EXPORT_KEYS = ['default', 'import', 'node', 'require'];
export const exportPath = (value, leaf, types = false) => {
    if (typeof value === 'string')
        return leaf(value);
    if (!value || typeof value !== 'object')
        return '';
    const obj = value;
    const typed = obj.types;
    if (types && typeof typed === 'string')
        return typed;
    for (const key of EXPORT_KEYS) {
        const res = exportPath(obj[key], leaf, types);
        if (res)
            return res;
    }
    for (const entry of Object.values(obj)) {
        const res = exportPath(entry, leaf, types);
        if (res)
            return res;
    }
    return '';
};
export const jsPath = (value) => exportPath(value, (path) => (/\.(?:c|m)?js$/.test(path) ? path : ''));
export const dtsPath = (value) => exportPath(value, (path) => {
    if (/\.d\.(?:c|m)?ts$/.test(path))
        return path;
    return /\.(?:c|m)?js$/.test(path) ? path.replace(/\.(?:c|m)?js$/, '.d.ts') : '';
}, true);
const exportSpec = (pkg, key) => key === '.' ? pkg.name : `${pkg.name}/${key.slice(2)}`;
export const publicEntries = (ctx) => Object.entries(ctx.pkg.exports)
    .flatMap(([key, value]) => {
    if (!key.startsWith('.'))
        return [];
    const jsRel = jsPath(value);
    return jsRel ? [{ jsRel, key, spec: exportSpec(ctx.pkg, key), value }] : [];
})
    .sort((a, b) => a.key.localeCompare(b.key));
export const listModules = (ctx) => {
    const mods = [];
    for (const { jsRel, key, spec, value } of publicEntries(ctx)) {
        const dtsRel = key === '.' && ctx.pkg.types
            ? ctx.pkg.types
            : dtsPath(value) || jsRel.replace(/\.(?:c|m)?js$/, '.d.ts');
        const jsFile = resolve(ctx.cwd, jsRel);
        const dtsFile = resolve(ctx.cwd, dtsRel);
        if (!existsSync(jsFile))
            err(`missing public JS entry ${jsRel} for ${key} in ${ctx.pkgFile}`);
        if (!existsSync(dtsFile))
            err(`missing public declaration file ${dtsRel} for ${key} in ${ctx.pkgFile}`);
        mods.push({ dtsFile, jsFile, key, spec });
    }
    if (!mods.length)
        err(`no public modules found in ${ctx.pkgFile}`);
    return mods;
};
export const publicRows = async (ctx, probe) => {
    const rows = [];
    for (const mod of listModules(ctx)) {
        rows.push({
            ...mod,
            file: relName(ctx.cwd, mod.jsFile),
            ...(await probe(mod)),
        });
    }
    return rows;
};
