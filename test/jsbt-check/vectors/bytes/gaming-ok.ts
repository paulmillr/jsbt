import type { RetU8A } from './utils.ts';

type Bytes<T extends Uint8Array> = T;
type Box<T extends Uint8Array> = { value: Bytes<T> };

const take = (_arg: Box<Uint8Array>): void => {};
const make = (): Box<RetU8A> => 1 as any;

void [take, make];
