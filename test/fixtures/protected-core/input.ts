// Synthetic application core; no product source or assets are used here.
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

function read(box: Box | null): number {
  return box === null ? 0 : box.value;
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
  const fallback: number | null = value > 0 ? value : null;
  const pair = [total, fallback ?? 0];
  const [left, right] = pair;
  const counter = new Counter();
  const box: Box | null = { value: counter.add(left + right) };
  const reader: Reader = isReader("sun") ? "sun" : "moon";
  return safe(read(box) + (reader === "sun" ? 1 : 0));
}
