import type { RetU8A } from './utils.ts';

declare const make: () => RetU8A;
type Box = { value: ReturnType<typeof make> };

const take = (_arg: Box): void => {};

void take;
