// New TS rejects nested RetU8A input because old plain Uint8Array callers are wider.
type RetU8A = ReturnType<typeof Uint8Array.of>;
type Input = { buf: RetU8A };

declare const src: { buf: Uint8Array };

const take = (arg: Input) => arg;

take(src);

export {};
