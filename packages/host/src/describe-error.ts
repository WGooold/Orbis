/** 给日志和 CLI 用的一句话描述。 */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
