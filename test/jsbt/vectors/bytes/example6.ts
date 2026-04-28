// Broad nested Uint8Array input accepts RetU8A sources on both old and new TS.
type RetU8A = ReturnType<typeof Uint8Array.of>;
type Input = { buf: Uint8Array };

declare const src: { buf: RetU8A };

const take = (arg: Input) => arg;

take(src);

export {};
