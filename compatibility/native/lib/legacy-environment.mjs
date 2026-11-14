/** Legacy overrides must never silently configure the renamed runtime. */
export function legacyEnvironmentWarnings(env) {
  return Object.keys(env).filter(name => name.startsWith('CODEX_CLAUDE_BRIDGE_') && env[name] !== undefined)
    .sort().map(name => `${name} is no longer supported; use ${name.replace('CODEX_CLAUDE_BRIDGE_', 'CLAUDE_CODEX_BRIDGE_')} instead.`);
}
