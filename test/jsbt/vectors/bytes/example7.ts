// Nested raw Uint8Array output still widens to ArrayBufferLike on new TS.
type Output = { buf: Uint8Array };

function test7(): Output {
  return 1 as any;
}

crypto.subtle.digest('SHA-256', test7().buf);

export {};
