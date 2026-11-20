import fs from 'node:fs';
import { executeBridgeTool } from '../../lib/bridge-service.mjs';
import { readProcessStart } from '../../lib/claude-process.mjs';
import { runMcpServer } from '../../scripts/mcp.mjs';

const { FIXTURE_PROBE_FILE: probeFile, FIXTURE_IDENTITY_MODE: mode, FIXTURE_CALLER: peer } = process.env;
if (!probeFile || !['native', 'fixture'].includes(mode) || !['codex', 'desktop', 'cli'].includes(peer)) {
  throw new Error('Missing fixture identity configuration');
}
let entries;
let calls = 0;
await runMcpServer({ executor(name, args, context) {
  const caller = peer !== 'codex' ? peer
    : context.metadata['x-codex-turn-metadata']?.thread_id === 'codex-target-b' ? 'codex-b' : 'codex-a';
  const call = ++calls;
  let proof = 1;
  let attempts = 0;
  return executeBridgeTool(name, args, { ...context, async processProbe(pid, options) {
    entries ??= JSON.parse(fs.readFileSync(probeFile, 'utf8'));
    const entry = entries[pid];
    if (mode === 'fixture') return entry ? { start: entry.start } : { missing: true };
    const subject = ['desktop', 'cli'].includes(entry?.id) ? entry.id : 'unknown';
    const started = performance.now();
    const attempt = ++attempts;
    let category;
    try {
      const answer = await readProcessStart(pid, options);
      category = answer?.missing ? 'missing' : /^\d+$/.test(answer?.start ?? '') ? 'answered' : 'inconclusive';
      return answer;
    } catch (error) {
      category = options.signal?.reason?.code === 'ATTEMPT_TIMEOUT' ? 'timeout'
        : options.signal?.aborted ? 'aborted' : error.transient ? 'inconclusive' : 'unavailable';
      throw error;
    } finally {
      process.stderr.write(`C5 proof ${caller} ${subject} call${call} proof${proof} attempt${attempt} ${category} ${Math.round(performance.now() - started)}ms\n`);
      if (category === 'answered' || category === 'missing') { proof++; attempts = 0; }
    }
  } });
} });
