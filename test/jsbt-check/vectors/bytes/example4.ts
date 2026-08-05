// New TS rejects passing a plain Uint8Array return into a narrow RetU8A parameter.
// Old TS accepts it because plain Uint8Array is the only available shape there.
type RetU8A = ReturnType<typeof Uint8Array.of>;

function test4(arg: RetU8A): RetU8A {
  return arg;
}

function test4Source(): Uint8Array {
  return 1 as any;
}

test4(test4Source());

export {};
