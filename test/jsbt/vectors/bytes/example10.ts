// Generic non-Uint8 typed arrays are still old-TS incompatible.
function test10(): Uint32Array<ArrayBuffer> {
  return 1 as any;
}

void test10;
export {};
