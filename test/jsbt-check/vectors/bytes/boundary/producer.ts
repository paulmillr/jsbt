export type RetU8A = ReturnType<typeof Uint8Array.of>;
export type Produced = { buf: RetU8A };

export const make = (_arg: Uint8Array): RetU8A => 1 as any;
export const makeBox = (_arg: Uint8Array): Produced => 1 as any;
