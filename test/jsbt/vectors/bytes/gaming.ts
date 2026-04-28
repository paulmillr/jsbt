import type { RetU8A } from './utils.ts';

type Bytes<T extends Uint8Array> = T;
type Box = { value: Bytes<RetU8A> };

const take = (_arg: Box): void => {};
const make = (): Box => 1 as any;

void [take, make];
