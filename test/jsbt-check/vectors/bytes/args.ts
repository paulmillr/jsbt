// Input parameters should stay broad; RetU8A is return-only.
declare const plain: Uint8Array;
declare const safe: Uint8Array<ArrayBuffer>;
declare const shared: Uint8Array<SharedArrayBuffer>;

type RetU8A = ReturnType<typeof Uint8Array.of>;

const takesPlain = (v: Uint8Array) => v;
const takesSafe = (v: Uint8Array<ArrayBuffer>) => v;
const takesRet = (v: RetU8A) => v;

takesPlain(plain);
takesPlain(safe);
takesPlain(shared);

takesSafe(plain);
takesSafe(safe);
takesSafe(shared);

takesRet(plain);
takesRet(safe);
takesRet(shared);

export {};
