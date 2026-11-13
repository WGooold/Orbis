/** APNS-L09: repeated live patches are not new task-completion edges. */
export class PushWakeReceipts {
  readonly #seen = new Set<string>();
  constructor(private readonly limit = 2048) {}
  observe(category: "task-completed" | "approval-requested", eventId: string): boolean {
    const key = `${category}:${eventId}`;
    if (this.#seen.has(key)) return false;
    this.#seen.add(key);
    while (this.#seen.size > this.limit) this.#seen.delete(this.#seen.values().next().value!);
    return true;
  }
}
