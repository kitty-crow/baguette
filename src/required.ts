/** Reject missing compiler state rather than assuming that a lookup succeeded. */
export function required<T>(value: T | null, description: string): NonNullable<T> {
  if (value == null) throw new Error("Missing compiler value: " + description);
  return value;
}
