type RetU8A = ReturnType<typeof Uint8Array.of>;

type Produced = { buf: RetU8A };

declare const produced: Produced;

const takesThirdParty = (_arg: { buf: Uint8Array }): void => {};

takesThirdParty(produced);

export {};
