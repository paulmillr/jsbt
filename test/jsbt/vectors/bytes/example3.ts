// RetU8A stays compatible across old and new TS.
type RetU8A = ReturnType<typeof Uint8Array.of>;

function test3(): RetU8A {
  return 1 as any;
}

crypto.subtle.digest('SHA-256', test3());

export {};
