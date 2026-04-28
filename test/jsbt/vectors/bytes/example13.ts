type RetU16A = ReturnType<typeof Uint16Array.of>;

function test(_arg: Uint16Array): RetU16A {
  return 1 as any;
}

void test;
