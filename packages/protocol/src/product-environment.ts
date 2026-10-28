/** Orbis names take precedence; older installations can keep their existing environment. */
export function orbisEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  return env[`ORBIS_${name}`] ?? env[`PI_REMOTE_${name}`];
}
