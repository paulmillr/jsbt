// Return-only aliases work for non-Uint8 typed arrays too.
type RetU32A = ReturnType<typeof Uint32Array.of>;

function test9(): RetU32A {
  return 1 as any;
}

void test9;
export {};
