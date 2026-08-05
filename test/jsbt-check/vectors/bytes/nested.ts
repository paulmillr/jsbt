import type { RetU8A } from './utils.ts';

type Input = {
  generic: Uint8Array<ArrayBuffer>;
  raw: Uint8Array;
  safe: RetU8A;
};
type Output = {
  raw: Uint8Array;
};

const takes = (_value: Input): void => {};
const make = (): Output => 1 as any;

void [takes, make];
export {};
