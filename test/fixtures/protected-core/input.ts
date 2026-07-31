// Synthetic application core; no product source or assets are used here.
type Reader = number;

function isReader(value: unknown): value is Reader {
  return value === 1 || value === 2;
}

class Counter {
  #value: number = 0;

  add(value: number): number {
    this.#value += value;
    return this.#value;
  }
}

class Box {
  value: number;

  constructor(value: number) {
    this.value = value;
  }
}

function read(box: Box): number {
  return box.value;
}

function safe(value: number): number {
  try {
    if (value < 0) throw new Error("negative");
    return value;
  } catch (code) {
    return -1;
  }
}

export function score(value: number): number {
  const counter = new Counter();
  const left = counter.add(value + 5);
  const right = value > 0 ? value : 0;
  const box = new Box(left + right);
  const reader: Reader = isReader(1) ? 1 : 2;
  return safe(read(box) + (reader === 1 ? 1 : 0));
}
