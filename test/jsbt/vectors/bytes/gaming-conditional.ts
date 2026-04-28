import type { RetU8A } from './utils.ts';

type Bytes<T extends Uint8Array> = T;
type Keep<T extends Uint8Array> = T extends Uint8Array ? Bytes<T> : never;
type Box = { value: Keep<RetU8A> };

const take = (_arg: Box): void => {};

void take;
