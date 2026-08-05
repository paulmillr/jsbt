// Nested RetU8A output stays portable across old and new TS.
type RetU8A = ReturnType<typeof Uint8Array.of>;
type Output = { buf: RetU8A };

function test8(): Output {
  return 1 as any;
}

crypto.subtle.digest('SHA-256', test8().buf);

export {};
