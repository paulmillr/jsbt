type RetU16A = ReturnType<typeof Uint16Array.of>;

function test(): RetU16A {
  return 1 as any;
}

void test;
