/** Reject missing compiler state rather than assuming that a lookup succeeded. */
export function required<T>(value: T | null | undefined, description: string): T {
  if (value === undefined || value === null) throw new Error("Missing compiler value: " + description);
  return value;
}
