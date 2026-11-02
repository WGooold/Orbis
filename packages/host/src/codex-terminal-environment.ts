/** Desktop's private source override can leak into Host when it is launched by an
 * agent. Keep it out of independent terminal children without changing Host or GUI env. */
export function codexTerminalEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(base)
    .filter(([key]) => key.toUpperCase() !== "CODEX_INTERNAL_ORIGINATOR_OVERRIDE"));
}
