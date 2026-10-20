/** `days` from today as YYYY-MM-DD, the shape a goal's end_date takes. */
export function addDays(days: number, from: Date = new Date()): string {
  const d = new Date(from);
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0]!;
}
