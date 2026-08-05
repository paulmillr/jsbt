const __jsbtCases = [
  {
    argNames: ['_tag', 'data'],
    autoRet: true,
    deep: [false],
    line: 54,
    missing: [false, false],
    name: 'makeSecret.open',
    ownerName: 'makeSecret',
    probe: [false, true],
  },
];
const __jsbtMethodParams = {
  create: { names: ['data'], required: 1 },
  'Box.open': { names: ['_tag', 'data'], required: 2 },
  open: { names: ['_tag', 'data'], required: 2 },
};
const __jsbtPrivateClasses = new Set(['_Secret']);
const __jsbtPrivateMethods = new Set(['Box.secret', 'Box._skip']);
const __jsbtPrivateName = (name) => typeof name === 'string' && name.startsWith('_');
const __jsbtIdent = (name) => /^[A-Za-z_$][\w$]*$/.test(name || '');
const __jsbtMaxRetMethods = 64;
const __jsbtRecords = [];
const __jsbtHex = (b) => Array.from(b, (i) => i.toString(16).padStart(2, '0')).join('');
const __jsbtIsBytes = (v) => v instanceof Uint8Array;
const __jsbtPlain = (v) =>
  !!v &&
  typeof v === 'object' &&
  !ArrayBuffer.isView(v) &&
  !(v instanceof ArrayBuffer) &&
  Object.getPrototypeOf(v) === Object.prototype;
const __jsbtChildren = (value) => {
  if (Array.isArray(value)) return value.map((val, key) => [key, val]);
  if (__jsbtPlain(value)) return Object.entries(value);
  return [];
};
const __jsbtTextPath = (path, key) =>
  typeof key === 'number' ? path + '[' + key + ']' : path ? path + '.' + key : key;
const __jsbtMark = (value, seen) => {
  if (!value || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  return true;
};
const __jsbtBytes = (value, path = '', out = [], seen = new WeakSet()) => {
  if (value && typeof value === 'object' && !__jsbtMark(value, seen)) return out;
  if (__jsbtIsBytes(value)) {
    out.push({ path, value, hex: __jsbtHex(value), dec: Array.from(value).join(',') });
  } else {
    for (const [key, val] of __jsbtChildren(value))
      __jsbtBytes(val, __jsbtTextPath(path, key), out, seen);
  }
  return out;
};
const __jsbtRecord = (idx, args, props) => {
  const item = __jsbtCases[idx];
  const rec = {
    ...item,
    args,
    before: __jsbtBytes(args, 'arg').map((ref) => ({ ...ref })),
    ...props,
  };
  __jsbtRecords.push(rec);
  return rec;
};
const __jsbtSave = (rec, run, awaitable = true) => {
  try {
    const ret = run();
    rec.ret = ret;
    if (awaitable && ret && typeof ret.then === 'function')
      return ret.then((value) => (rec.ret = value));
    return ret;
  } catch (error) {
    rec.error = error;
    throw error;
  }
};
const __jsbtCall = (idx, fn, self, args) => {
  return __jsbtSave(__jsbtRecord(idx, args, { fn, self }), () => fn.apply(self, args));
};
const __jsbtNew = (idx, fn, args) => {
  return __jsbtSave(__jsbtRecord(idx, args, { fn, newExpr: true }), () => new fn(...args), false);
};
const __jsbtMethod = (idx, getSelf, member, args) => {
  const self = getSelf();
  return __jsbtSave(
    __jsbtRecord(idx, args, { fn: self && self[member], getSelf, member, self }),
    () => self[member].apply(self, args)
  );
};
import { makeSecret } from 'file:///home/user/Developer/personal/jsbt/test/jsbt/vectors/errors/private-skip/index.js';
__jsbtMethod(0, () => makeSecret(new Uint8Array([1])), 'open', [new Uint8Array([2])]);
const __jsbtIssues = [];
const __jsbtRejects = [];
const __jsbtDocs =
  "\nPublic factory returning a private implementation class.\n@param data - Seed bytes for the private implementation.\n@returns Private implementation instance.\n@example\nConstruct a private implementation through its public factory.\n\n```ts\nimport { makeSecret } from '@jsbt-test/errors-private-skip';\nmakeSecret(new Uint8Array([1])).open(new Uint8Array([2]));\n```\n";
const __jsbtDocRe = /\b(alias|same|reuse|return(?:s|ed)? input|mutat|in place)\b/i;
const __jsbtDocumented = __jsbtDocRe.test(__jsbtDocs);
const __jsbtClone = (v) => {
  if (__jsbtIsBytes(v)) return new Uint8Array(v);
  if (Array.isArray(v)) return v.map(__jsbtClone);
  if (__jsbtPlain(v))
    return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, __jsbtClone(val)]));
  return v;
};
const __jsbtSet = (root, path, value) => {
  if (!path.length) return value;
  const out = Array.isArray(root) ? root.slice() : { ...root };
  let cur = out;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    const val = cur[key];
    cur[key] = Array.isArray(val) ? val.slice() : __jsbtPlain(val) ? { ...val } : {};
    cur = cur[key];
  }
  cur[path[path.length - 1]] = value;
  return out;
};
const __jsbtWalk = (value, path = [], out = [], seen = new WeakSet(), deep = true) => {
  if (value && typeof value === 'object' && !__jsbtMark(value, seen)) return out;
  const add = (vals) => out.push({ path, vals });
  if (__jsbtIsBytes(value)) add([false, '__jsbt_wrong_string__', [1, 2, 3]]);
  else if (typeof value === 'boolean') add([0, 'true', null]);
  else if (typeof value === 'number') add([true, false, null, '1', value + 0.1]);
  else if (typeof value === 'string') add([false, 1, {}]);
  else if (typeof value === 'function') add([true, false, null]);
  else if (Array.isArray(value)) {
    add([false, {}, '__jsbt_wrong_array__']);
    const children = __jsbtChildren(value);
    if (deep && children.length)
      __jsbtWalk(children[0][1], path.concat(children[0][0]), out, seen, deep);
  } else if (__jsbtPlain(value)) {
    add([false, null, '__jsbt_wrong_object__']);
    if (deep) {
      for (const [key, val] of __jsbtChildren(value))
        __jsbtWalk(val, path.concat(key), out, seen, deep);
    }
  } else if (value && typeof value === 'object') {
    // Public key/signature point instances still need top-level runtime type probes.
    add([false, null, '__jsbt_wrong_string__', {}, [1, 2, 3]]);
  }
  return out;
};
const __jsbtChanged = (before, after, out = []) => {
  for (let i = 0; i < before.length; i++) {
    const a = before[i];
    const b = after.find((item) => item.value === a.value);
    if (b && a.hex !== b.hex) out.push(a.path || 'arg');
  }
  return out;
};
const __jsbtLeaks = (message, refs) =>
  refs.some(
    (ref) => ref.hex.length >= 16 && (message.includes(ref.hex) || message.includes(ref.dec))
  );
const __jsbtAlias = (value, refs, seen = new WeakSet()) => {
  if (__jsbtIsBytes(value) && refs.some((ref) => ref.value === value)) return true;
  if (!__jsbtMark(value, seen)) return false;
  for (const [, item] of __jsbtChildren(value)) if (__jsbtAlias(item, refs, seen)) return true;
  return false;
};
const __jsbtRetMethods = (
  value,
  path = [],
  out = [],
  seen = new WeakSet(),
  includeZero = false
) => {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return out;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return out;
  if (seen.has(value) || path.length > 3 || out.length >= __jsbtMaxRetMethods) return out;
  seen.add(value);
  const local = [];
  const nested = [];
  const seenMethods = new Set();
  const scan = (obj, self, proto = false) => {
    for (const key of Reflect.ownKeys(obj)) {
      if (typeof key !== 'string' || key === 'constructor' || key.startsWith('_')) continue;
      const desc = Object.getOwnPropertyDescriptor(obj, key);
      if (!desc || !('value' in desc)) continue;
      const next = path.concat(key);
      const val = desc.value;
      if (
        typeof val === 'function' &&
        !['apply', 'bind', 'call'].includes(key) &&
        // Returned API objects often expose constructors; new examples cover those explicitly.
        !/^class\s/.test(Function.prototype.toString.call(val))
      ) {
        const id = next.join('.');
        if (seenMethods.has(id)) continue;
        seenMethods.add(id);
        local.push({ argc: Math.min(val.length, 4), fn: val, path: next, self });
      } else if (!proto && (__jsbtPlain(val) || Array.isArray(val))) {
        nested.push({ path: next, value: val });
      }
    }
  };
  scan(value, value);
  if (typeof value !== 'function') {
    let proto = Object.getPrototypeOf(value);
    for (let depth = 0; proto && depth < 6; depth++, proto = Object.getPrototypeOf(proto)) {
      if (proto === Object.prototype || proto === Array.prototype) break;
      scan(proto, value, true);
    }
  }
  // Large math/point/factory objects are too broad; keep documented methods when available.
  const methods =
    local.length > 8 ? local.filter((method) => __jsbtHasRetArgNames(method.path)) : local;
  if (local.length > 8 && !methods.length) return out;
  for (const method of methods) {
    if (includeZero || method.argc > 0) out.push(method);
    if (out.length >= __jsbtMaxRetMethods) return out;
  }
  for (const item of nested) {
    __jsbtRetMethods(item.value, item.path, out, seen, includeZero);
    if (out.length >= __jsbtMaxRetMethods) return out;
  }
  return out;
};
const __jsbtFnArgNames = (fn) => {
  if (typeof fn !== 'function') return [];
  const src = Function.prototype.toString.call(fn).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n\r]*/g, '');
  const match =
    src.match(/^(?:async\s+)?function(?:\s+[A-Za-z_$][\w$]*)?\s*\(([^)]*)\)/) ||
    src.match(/^(?:async\s+)?#?[A-Za-z_$][\w$]*\s*\(([^)]*)\)\s*\{/) ||
    src.match(/^(?:async\s*)?\(([^)]*)\)\s*=>/) ||
    src.match(/^(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>/);
  const raw = (match && match[1]) || '';
  const out = [];
  for (const part of raw.split(',')) {
    const name = part
      .replace(/=.*/, '')
      .replace(/^\.\.\./, '')
      .trim();
    if (__jsbtIdent(name)) out.push(name);
  }
  return out;
};
// Returned methods are discovered at runtime; prefer actual names over short-name docs.
const __jsbtStaticParams = (path) => {
  const key = path.join('.');
  return __jsbtMethodParams[key] || __jsbtMethodParams[path[path.length - 1]];
};
const __jsbtArgNames = (fn, path, argc, fallback = []) => {
  // Runtime function names keep variable calls like cipher.encrypt() from
  // inheriting a same-named static helper signature from another API shape.
  const runtime = __jsbtFnArgNames(fn);
  const stat = __jsbtStaticParams(path);
  const statNames = (stat && stat.names) || [];
  const params =
    runtime.length && statNames.length && runtime.length > statNames.length
      ? runtime.slice(0, statNames.length)
      : runtime.length
        ? runtime
        : fallback.length
          ? fallback
          : statNames;
  return Array.from(
    { length: Math.max(Math.min(argc, params.length || argc), params.length) },
    (_, i) => params[i] || 'arg' + i
  );
};
const __jsbtHasRetArgNames = (path) => {
  return !!__jsbtStaticParams(path);
};
const __jsbtRequiredArgs = (path, argc) => {
  const stat = __jsbtStaticParams(path);
  return stat ? Math.min(argc, stat.required) : argc;
};
const __jsbtMessageArg = (name) =>
  /^(?:msg|message|messages|data|input|buf|bytes|plaintext|ciphertext)$/i.test(name || '');
const __jsbtArgAliases = (name) => {
  const aliases = [name];
  const add = (...items) => {
    for (const item of items) if (item && !aliases.includes(item)) aliases.push(item);
  };
  if (name === 'msg') add('message', 'messageBytes', 'data');
  else if (name === 'message') add('msg', 'messageBytes', 'data');
  else if (name === 'messageBytes') add('message', 'msg');
  else if (name === 'sig') add('signature');
  else if (name === 'signature') add('sig');
  else if (name === 'pk') add('publicKey');
  else if (name === 'publicKey') add('pk', 'publicKeyB', 'uCoordinate');
  else if (name === 'publicKeyB' || name === 'uCoordinate') add('publicKey');
  else if (name === 'out' || name === 'dst' || name === 'output') add('out', 'dst', 'output');
  else if (name === 'plaintext' || name === 'ciphertext' || name === 'data')
    add('plaintext', 'ciphertext', 'data');
  return aliases;
};
const __jsbtKnownArg = Symbol('jsbt-known-arg');
const __jsbtKnownRow = (known, key) => {
  if (!key) return;
  const prev = known.get(key);
  if (prev) return prev;
  const row = new Map();
  known.set(key, row);
  return row;
};
const __jsbtAddKnown = (known, key, name, value) => {
  if (!name || __jsbtPrivateName(name) || value === undefined) return;
  const row = __jsbtKnownRow(known, key);
  if (!row) return;
  for (const alias of __jsbtArgAliases(name)) if (!row.has(alias)) row.set(alias, value);
};
const __jsbtRecordMethodPath = (item) => {
  const parts = String(item.name || item.member || '')
    .split('.')
    .filter(Boolean);
  const idx = parts.lastIndexOf(item.member);
  return (idx > 0 ? parts.slice(1, idx + 1) : [item.member]).filter(Boolean).join('.');
};
const __jsbtRecordKeys = (item) => {
  if (!item.member) return item.name ? [item.name] : [];
  const path = __jsbtRecordMethodPath(item);
  const keys = [];
  if (item.ownerName && path) keys.push(item.ownerName + '.' + path);
  if (item.name) keys.push(item.name);
  return keys;
};
const __jsbtKnownValue = (known, keys, name) => {
  for (const key of keys) {
    const row = known.get(key);
    if (!row) continue;
    for (const alias of __jsbtArgAliases(name)) if (row.has(alias)) return row.get(alias);
  }
  return __jsbtKnownArg;
};
const __jsbtKnownArgs = (records) => {
  const known = new Map();
  for (const item of records) {
    const args = item.args || [];
    const names = item.member
      ? __jsbtArgNames(item.fn, [item.member], args.length, item.argNames)
      : item.argNames || [];
    for (const key of ['*', ...__jsbtRecordKeys(item)])
      for (let i = 0; i < args.length; i++) __jsbtAddKnown(known, key, names[i], args[i]);
  }
  return known;
};
const __jsbtKnownMethodKeys = (item, method) => {
  const path = method.path.join('.');
  return item.name && path ? [item.name + '.' + path] : [];
};
const __jsbtKnownMethodArgs = (known, keys, names, len) =>
  Array.from({ length: Math.max(len, names.length) }, (_, i) =>
    __jsbtKnownValue(known, keys, names[i] || 'arg' + i)
  );
const __jsbtNameIdx = (names, re) => names.findIndex((name) => re.test(name || ''));
const __jsbtSuiteRecord = (suite, member) =>
  __jsbtRecords.find((rec) => rec.self === suite && rec.member === member && !rec.error);
const __jsbtFillSignerArgs = (known, method, names, base) => {
  const member = method.path[method.path.length - 1];
  if (member !== 'sign' && member !== 'verify') return base;
  const msgIdx = __jsbtNameIdx(names, /^(?:msg|message|messages)$/i);
  const secretIdx = __jsbtNameIdx(names, /^(?:secretKey|privateKey|sk)$/i);
  const sigIdx = member === 'verify' ? __jsbtNameIdx(names, /^(?:sig|signature)$/i) : -1;
  const keyIdx = member === 'verify' ? __jsbtNameIdx(names, /^(?:publicKey|pk|key)$/i) : -1;
  if (msgIdx < 0) return base;
  if (member === 'sign' && secretIdx < 0) return base;
  if (member === 'verify' && (sigIdx < 0 || keyIdx < 0)) return base;
  const suite = method.self;
  if (!suite) return base;
  const out = base.slice();
  const set = (idx, value) => {
    if (idx >= 0 && value !== undefined) out[idx] = value;
  };
  const exact = __jsbtSuiteRecord(suite, member);
  if (exact && exact.args.length) {
    if (member === 'sign') {
      set(msgIdx, exact.args[msgIdx]);
      set(secretIdx, exact.args[secretIdx]);
      return out;
    }
    set(sigIdx, exact.args[sigIdx]);
    set(msgIdx, exact.args[msgIdx]);
    set(keyIdx, exact.args[keyIdx]);
    return out;
  }
  if (typeof suite.keygen !== 'function') return base;
  const knownMsg =
    out[msgIdx] !== __jsbtKnownArg ? out[msgIdx] : __jsbtKnownValue(known, ['*'], names[msgIdx]);
  if (knownMsg === __jsbtKnownArg) return base;
  const candidates = [knownMsg];
  // BLS-like signer suites expose hash() to convert raw messages into the suite's point type.
  if (typeof suite.hash === 'function') {
    try {
      candidates.unshift(suite.hash(__jsbtClone(knownMsg)));
    } catch {}
  }
  for (const msg of candidates) {
    try {
      const keys = suite.keygen();
      const secretKey = keys && (keys.secretKey || keys.privateKey);
      const publicKey = keys && keys.publicKey;
      if (secretKey === undefined) continue;
      set(msgIdx, msg);
      if (member === 'sign') {
        set(secretIdx, secretKey);
        return out;
      }
      if (typeof suite.sign !== 'function' || publicKey === undefined) continue;
      const sig = suite.sign(__jsbtClone(msg), secretKey);
      set(sigIdx, sig);
      set(keyIdx, publicKey);
      return out;
    } catch {
      continue;
    }
  }
  return base;
};
const __jsbtCallableArgs = (item, method) => {
  const names = __jsbtArgNames(method.fn, method.path, method.argc);
  const byName = new Map(item.argNames.map((name, i) => [name, item.args[i]]));
  const out = [];
  let matched = false;
  for (const name of names) {
    if (__jsbtPrivateName(name)) return;
    if (byName.has(name)) {
      out.push(byName.get(name));
      matched = true;
    }
  }
  if (matched || !method.argc || names.length) return out;
  return item.args.filter((_, i) => !__jsbtMessageArg(item.argNames[i])).slice(0, method.argc);
};
const __jsbtPrivateRetMethod = (item, ret, path) => {
  const name = item.name + '.' + path.join('.');
  if (__jsbtPrivateMethods.has(name)) return true;
  const cls = ret && ret.constructor && ret.constructor.name;
  if (cls && __jsbtPrivateClasses.has(cls)) return true;
  return !!cls && __jsbtPrivateMethods.has(cls + '.' + path.join('.'));
};
const __jsbtMsg = (err) => (err && typeof err.message === 'string' ? err.message : String(err));
const __jsbtSeen = new Set();
const __jsbtAdd = (level, kind, line, call, detail) => {
  const head = String(detail).split('\n')[0];
  const key = level + '\0' + kind + '\0' + line + '\0' + call + '\0' + head;
  if (__jsbtSeen.has(key)) return;
  __jsbtSeen.add(key);
  __jsbtIssues.push({ call, detail, kind, level, line });
};
const __jsbtNoError = new Set();
const __jsbtAddAccepted = (item, label, probe) => {
  const name = __jsbtProbeName(probe);
  const key = item.line + '\0' + item.name + '\0' + label + '\0' + name;
  if (__jsbtNoError.has(key)) return;
  __jsbtNoError.add(key);
  __jsbtRejects.push({
    accepted: true,
    call: item.name,
    label,
    line: item.line,
    message: 'NO ERROR!',
    probe: name,
  });
};
const __jsbtLabel = (arg, path) => (path.length ? arg + '.' + path.join('.') : arg);
const __jsbtProbeName = (value) => {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (value === false) return 'false';
  if (value === true) return 'true';
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'NaN';
    if (!Number.isInteger(value)) return 'float';
    return String(value);
  }
  if (typeof value === 'bigint') return 'bigint';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'symbol') return 'symbol';
  if (typeof value === 'function')
    return /^class\s/.test(Function.prototype.toString.call(value)) ? 'class' : 'function';
  if (Array.isArray(value)) return 'array';
  if (__jsbtIsBytes(value)) return 'Uint8Array(len=' + value.length + ')';
  if (ArrayBuffer.isView(value))
    return (
      value.constructor.name +
      '(len=' +
      (value.length === undefined ? value.byteLength : value.length) +
      ')'
    );
  if (value instanceof ArrayBuffer) return 'ArrayBuffer(len=' + value.byteLength + ')';
  return value && value.constructor && value.constructor.name !== 'Object'
    ? value.constructor.name
    : 'object';
};
const __jsbtCheckMsg = (item, label, probe, err, refs) => {
  const message = __jsbtMsg(err);
  __jsbtRejects.push({
    call: item.name,
    label,
    line: item.line,
    message,
    probe: __jsbtProbeName(probe),
  });
  if (__jsbtLeaks(message, refs))
    __jsbtAdd(
      'ERROR',
      'leak',
      item.line,
      item.name,
      'error message exposes byte input value for ' + label
    );
};
const __jsbtExpectReject = async (item, label, refs, probe, run, awaitable = true) => {
  try {
    const ret = run();
    if (awaitable) await ret;
    __jsbtAddAccepted(item, label, probe);
  } catch (error) {
    __jsbtCheckMsg(item, label, probe, error, refs);
  }
};
const __jsbtProbeValues = async (item, label, refs, vals, run, awaitable = true) => {
  for (const value of vals)
    await __jsbtExpectReject(item, label, refs, value, () => run(value), awaitable);
};
const __jsbtPublicMissingArg = (name) =>
  __jsbtIdent(name) &&
  !__jsbtPrivateName(name) &&
  !/^arg\d+$/.test(name) &&
  !/^unused(?:Arg)?$/i.test(name);
const __jsbtProducer = (value) =>
  __jsbtRecords.find((rec) => rec.autoRet && rec.ret === value && typeof rec.fn === 'function');
const __jsbtFreshValue = async (value) => {
  const rec = __jsbtProducer(value);
  if (!rec) return value;
  try {
    const args = rec.args.map(__jsbtClone);
    if (rec.member) {
      if (rec.self === value && typeof rec.getSelf === 'function') {
        const self = rec.getSelf();
        const fn = self && self[rec.member];
        return await fn.apply(self, args);
      }
      const self = await __jsbtFreshSelf(rec);
      const fn = self && self[rec.member];
      return await fn.apply(self, args);
    }
    return rec.newExpr ? new rec.fn(...args) : await rec.fn.apply(rec.self, args);
  } catch {
    return value;
  }
};
const __jsbtMethodAt = (value, path) => {
  let self = value;
  for (let i = 0; i < path.length - 1; i++) self = self && self[path[i]];
  const fn = self && self[path[path.length - 1]];
  return typeof fn === 'function' ? { fn, self } : undefined;
};
const __jsbtFreshMethod = async (method) => {
  // Stateful returned objects can be spent by the valid example before probes run.
  const fresh = await __jsbtFreshValue(method.self);
  return __jsbtMethodAt(fresh, method.path) || method;
};
const __jsbtFreshSelf = async (item) => {
  const fresh = await __jsbtFreshValue(item.self);
  if (fresh !== item.self) return fresh;
  // Inline chains such as hash.create().update() have no recorded factory value;
  // rerunning the self expression reconstructs the pre-finalized receiver.
  if (typeof item.getSelf === 'function') {
    try {
      return item.getSelf();
    } catch {}
  }
  return fresh;
};
const __jsbtMissing = () => [
  { path: [], vals: [false, '__jsbt_wrong_string__', {}, [1, 2, 3], null] },
];
// Keep nested option-object probing finite; large config objects multiply calls/noise.
const __jsbtMaxProbesPerArg = 12;
let __jsbtProbed = 0;
const __jsbtProbeRet = async (item, ret, refs, known) => {
  for (const method of __jsbtRetMethods(ret)) {
    const name = item.name + '.' + method.path.join('.');
    if (__jsbtPrivateRetMethod(item, ret, method.path)) continue;
    const names = __jsbtArgNames(method.fn, method.path, method.argc);
    const required = __jsbtRequiredArgs(method.path, method.argc);
    const vals = __jsbtMissing()[0].vals;
    // Returned-surface probing may run before/without the direct method record for this owner.
    // Reuse valid example arguments by name so later params are not probed with earlier args
    // accidentally left undefined.
    const base = __jsbtFillSignerArgs(
      known,
      method,
      names,
      __jsbtKnownMethodArgs(
        known,
        __jsbtKnownMethodKeys(item, method),
        names,
        Math.max(required, names.length)
      )
    );
    let probed = false;
    for (let i = 0; i < base.length; i++) {
      if (__jsbtPrivateName(names[i])) continue;
      const complete = base.every(
        (value, j) =>
          j === i || j >= required || (!__jsbtPrivateName(names[j]) && value !== __jsbtKnownArg)
      );
      if (i > 0 && !complete) continue;
      probed = true;
      await __jsbtProbeValues({ ...item, name }, names[i], refs, vals, (value) => {
        const args = base.map((item) => (item === __jsbtKnownArg ? undefined : __jsbtClone(item)));
        args[i] = value;
        return __jsbtFreshMethod(method).then((fresh) => fresh.fn.apply(fresh.self, args));
      });
    }
    if (probed) __jsbtProbed++;
  }
};
const __jsbtProbeCallableOutputs = async (item, refs, known) => {
  for (const method of __jsbtRetMethods(item.fn, [], [], new WeakSet(), true)) {
    const name = item.name + '.' + method.path.join('.');
    if (__jsbtPrivateMethods.has(name)) continue;
    const args = __jsbtCallableArgs(item, method);
    if (!args) continue;
    try {
      const ret = await method.fn.apply(method.self, args);
      await __jsbtProbeRet({ ...item, name }, ret, refs, known);
    } catch {}
  }
};
const __jsbtRun = async (records) => {
  const known = __jsbtKnownArgs(records);
  for (const item of records) {
    const args = item.args;
    const argNames = item.member
      ? __jsbtArgNames(item.fn, [item.member], args.length, item.argNames)
      : item.argNames;
    let ret;
    const refs = __jsbtBytes(args, 'arg');
    const before = item.before || refs.map((ref) => ({ ...ref }));
    try {
      if (item.error) throw item.error;
      ret = await item.ret;
    } catch (error) {
      __jsbtAdd(
        'WARN',
        'example',
        item.line,
        item.name,
        'cannot replay valid example call: ' + __jsbtMsg(error)
      );
      continue;
    }
    const changed = __jsbtChanged(before, __jsbtBytes(args, 'arg'));
    if (changed.length && !__jsbtDocumented)
      __jsbtAdd(
        'WARN',
        'mutation',
        item.line,
        item.name,
        'valid call mutates input at ' +
          changed.join(', ') +
          '; document explicit mutation or copy input'
      );
    if (__jsbtAlias(ret, refs) && !__jsbtDocumented)
      __jsbtAdd(
        'WARN',
        'alias',
        item.line,
        item.name,
        'return value aliases input; document returned-input aliasing or copy output'
      );
    let direct = false;
    for (let i = 0; i < Math.max(args.length, argNames.length); i++) {
      if (item.probe[i] === false) continue;
      const missing = i >= args.length;
      if (missing && !__jsbtPublicMissingArg(argNames[i])) continue;
      if (missing && !item.missing[i] && !item.member) continue;
      const probes = (
        missing ? __jsbtMissing() : __jsbtWalk(args[i], [], [], new WeakSet(), item.deep[i])
      ).slice(0, __jsbtMaxProbesPerArg);
      if (probes.length) direct = true;
      for (const probe of probes) {
        const label = __jsbtLabel(argNames[i] || 'arg' + i, probe.path);
        await __jsbtProbeValues(
          item,
          label,
          refs,
          probe.vals,
          (value) => {
            const next = args.slice();
            next[i] = missing ? value : __jsbtSet(__jsbtClone(args[i]), probe.path, value);
            if (!item.member)
              return item.newExpr ? new item.fn(...next) : item.fn.apply(item.self, next);
            return __jsbtFreshSelf(item).then((self) => {
              const fn = self && self[item.member];
              return fn.apply(self, next);
            });
          },
          !item.newExpr
        );
      }
    }
    if (direct) __jsbtProbed++;
    await __jsbtProbeCallableOutputs(item, refs, known);
    await __jsbtProbeRet(item, ret, refs, known);
  }
};
await __jsbtRun(__jsbtRecords);
export default { issues: __jsbtIssues, probed: __jsbtProbed, rejects: __jsbtRejects };
