type RetU8A = ReturnType<typeof Uint8Array.of>;

declare const safe: RetU8A;

const takesThirdParty = (_arg: Uint8Array): void => {};

takesThirdParty(safe);

export {};
