import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Replace only the process-start probes. The MCP loop, executor, lock protocol and
// transport code all come from the source under test.
const { spawn, spawnSync } = childProcess;
const identityHelper = fileURLToPath(new URL('./contention-identity.mjs', import.meta.url));
childProcess.spawn = (command, args, options) => command === 'powershell.exe' && args.at(-1)?.includes("WriteLine('R')")
  ? spawn(process.execPath, [identityHelper], options) : spawn(command, args, options);
childProcess.spawnSync = (command, args, options) => command === 'powershell.exe' && args.at(-1)?.includes('.StartTime.ToFileTimeUtc()')
  ? { status: 0, stdout: `${process.env.FIXTURE_PROCESS_START}\n` } : spawnSync(command, args, options);

// Report the first actual failure of the real exclusive link, not merely entry
// into a send. Also report any later acquisition of this lock after release.
const { linkSync } = fs;
// Compare the directory that holds the lock, including after its owner removes the file.
// Runner TEMP may name it through an 8.3 path or junction instead of the resolved ledger root.
const lockKey = file => path.join(fs.realpathSync.native(path.dirname(file)), path.basename(file));
const heldLock = lockKey(process.env.FIXTURE_HELD_LOCK);
let contending = false;
fs.linkSync = (from, to) => {
  if (lockKey(to) !== heldLock) return linkSync(from, to);
  try {
    const result = linkSync(from, to);
    process.send({ event: 'acquired' });
    return result;
  } catch (error) {
    if (error.code === 'EEXIST' && !contending) {
      contending = true;
      process.send({ event: 'contending' });
    }
    throw error;
  }
};
syncBuiltinESMExports();

const moduleUrl = process.env.BRIDGE_TEST_MCP_MODULE_URL
  ? new URL(process.env.BRIDGE_TEST_MCP_MODULE_URL)
  : new URL('../../scripts/mcp.mjs', import.meta.url);
if (moduleUrl.protocol !== 'file:') throw new Error('The test MCP module must be a local file URL.');
const { runMcpServer } = await import(moduleUrl);
const { executeBridgeTool } = await import(new URL('../lib/bridge-service.mjs', moduleUrl));
const { remainingMs } = await import(new URL('../lib/call-time.mjs', moduleUrl));
const deadlineMs = process.env.FIXTURE_DEADLINE_MS ? Number(process.env.FIXTURE_DEADLINE_MS) : undefined;
await runMcpServer({ deadlineMs, async executor(name, args, context) {
  try {
    return await executeBridgeTool(name, args, context);
  } finally {
    if (name === 'send_to_claude' || name === 'panel_send') {
      process.send({ event: 'settled', aborted: context.signal.aborted,
        stop: context.signal.reason?.code, remainingMs: remainingMs(context.signal) });
    }
  }
} });
process.disconnect();
