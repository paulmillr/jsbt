const block = new Int32Array(new SharedArrayBuffer(4));
Atomics.wait(block, 0, 0, 20);

export const slow = 42;
