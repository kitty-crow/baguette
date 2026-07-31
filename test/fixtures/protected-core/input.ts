type Reader = "sun" | "moon";

function isReader(value: unknown): value is Reader {
  return value === "sun" || value === "moon";
}

class Counter {
  #value: number = 0;

  add(value: number): number {
    this.#value += value;
    return this.#value;
  }
}

interface Box {
  value: number;
}

function read(box: Box | null): number | null {
  return box?.value;
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
  const values = [value, 2, 3];
  let total = 0;
  for (const item of values) total += item;
  const pair = [total, value ?? 0];
  const [left, right] = pair;
  const counter = new Counter();
  const box: Box | null = { value: counter.add(left + right) };
  const reader: Reader = isReader("sun") ? "sun" : "moon";
  return safe((read(box) ?? 0) + (reader === "sun" ? 1 : 0));
}
