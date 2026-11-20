/** Legacy overrides must never silently configure the renamed runtime. */
export function legacyEnvironmentWarnings(env) {
  return Object.keys(env).filter(name => name.startsWith('CODEX_CLAUDE_BRIDGE_') && env[name] !== undefined)
    .sort().map(name => {
      const suffix = name.slice('CODEX_CLAUDE_BRIDGE_'.length);
      return ['DAEMON', 'CODEX_BIN', 'REGISTRY_DIR', 'SSH_HOST', 'STATE_DIR'].includes(suffix)
        ? `${name} is no longer supported; use CLAUDE_CODEX_BRIDGE_${suffix} instead.`
        : 'An unrecognized legacy bridge setting was ignored. Consult the supported configuration settings.';
    });
}
