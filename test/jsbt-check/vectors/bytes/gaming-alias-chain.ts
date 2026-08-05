import type { RetU8A } from './utils.ts';

type Bytes<T extends Uint8Array> = T;
type Out<T extends Uint8Array> = Bytes<T>;
type Box = { value: Out<RetU8A> };

const take = (_arg: Box): void => {};

void take;
