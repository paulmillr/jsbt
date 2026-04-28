import type { RetU8A } from './utils.ts';

class InputBox {
  buf: RetU8A = 1 as any;
}

class OutputBox {
  buf: Uint8Array = 1 as any;
}

const takeBox = (_arg: InputBox): void => {};
const makeBox = (): OutputBox => 1 as any;

void [takeBox, makeBox];
