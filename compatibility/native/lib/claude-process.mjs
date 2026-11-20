import { hostname } from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { inquire } from './call-time.mjs';
import { failure } from './outcome.mjs';

const FILETIME = /^[0-9]+$/;
const PS_LSTART = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [ 0-3]\d \d{2}:\d{2}:\d{2} \d{4}$/;

const transient = message => Object.assign(new Error(message), { transient: true });
const permanent = message => Object.assign(new Error(message), { permanent: true });

// Windows: one long-lived PowerShell answers creation-time queries over stdio. A shell per
// query costs hundreds of milliseconds, seconds under load; a query to the running helper costs
// about one. It reads one decimal PID per line and prints S:<FILETIME>, E:N (no such process or it
// exited) or E:F (the OS refused the query). Only validated PIDs are written to it.
const HELPER_SCRIPT = "$ErrorActionPreference='Stop';[Console]::Out.WriteLine('R');" +
  "while($null -ne ($l=[Console]::In.ReadLine())){$n=0;if(-not [int]::TryParse($l,[ref]$n)){[Console]::Out.WriteLine('E:F');continue};" +
  "try{[Console]::Out.WriteLine('S:'+[Diagnostics.Process]::GetProcessById($n).StartTime.ToFileTimeUtc().ToString())}" +
  "catch [ArgumentException]{[Console]::Out.WriteLine('E:N')}catch [InvalidOperationException]{[Console]::Out.WriteLine('E:N')}" +
  "catch{[Console]::Out.WriteLine('E:F')}}";
// The helper exits after this long without queries, so an idle bridge holds no extra process.
const HELPER_IDLE_MS = 60_000;

class WindowsProcessHelper {
  constructor({ spawnImpl = spawn, idleMs = HELPER_IDLE_MS } = {}) {
    this.spawnImpl = spawnImpl;
    this.idleMs = idleMs;
    this.child = null;
    this.queue = [];
    this.active = null;
    this.idleTimer = null;
  }

  query(pid, signal) {
    if (signal?.aborted) return Promise.reject(transient('The process check was interrupted.'));
    return new Promise((resolve, reject) => {
      const job = { pid, resolve, reject, signal, onAbort: null };
      job.onAbort = () => this.abandon(job);
      signal?.addEventListener('abort', job.onAbort, { once: true });
      this.queue.push(job);
      clearTimeout(this.idleTimer);
      this.pump();
    });
  }

  settle(job, error, value) {
    job.signal?.removeEventListener('abort', job.onAbort);
    if (error) job.reject(error);
    else job.resolve(value);
  }

  abandon(job) {
    const queued = this.queue.indexOf(job);
    if (queued >= 0) this.queue.splice(queued, 1);
    if (this.active === job || (queued === 0 && this.child && !this.child.ready)) {
      // Its answer may still arrive and would be read as the next query's: replace the helper.
      this.active = null;
      const helper = this.child;
      this.child = null;
      helper?.child.kill();
    }
    this.settle(job, transient('The process check was interrupted.'));
    this.pump();
  }

  start() {
    let child;
    try {
      child = this.spawnImpl('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', HELPER_SCRIPT],
        { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    } catch (error) {
      this.failAll(error.code === 'ENOENT' ? permanent('PowerShell is unavailable.') : transient('PowerShell could not start.'));
      return;
    }
    const helper = { child, ready: false, buffer: '' };
    this.child = helper;
    // Only active jobs keep the bridge alive; pump() releases the child as soon as the queue drains.
    child.stdin?.unref?.();
    child.stdout?.unref?.();
    child.stdout?.setEncoding('utf8');
    child.stdin?.on('error', () => {});
    child.on('error', error => this.lost(helper, error.code === 'ENOENT'
      ? permanent('PowerShell is unavailable.') : transient('PowerShell could not start.')));
    child.on('exit', () => this.lost(helper, transient('The process check helper exited.')));
    child.stdout?.on('data', chunk => {
      helper.buffer += chunk;
      for (let newline; (newline = helper.buffer.indexOf('\n')) >= 0;) {
        const line = helper.buffer.slice(0, newline).trim();
        helper.buffer = helper.buffer.slice(newline + 1);
        this.answer(helper, line);
      }
    });
  }

  answer(helper, line) {
    if (this.child !== helper) return;
    if (!helper.ready) {
      if (line !== 'R') { this.lost(helper, transient('The process check helper did not start correctly.')); return; }
      helper.ready = true;
      this.pump();
      return;
    }
    const job = this.active;
    this.active = null;
    if (!job) { this.lost(helper, transient('The process check helper answered out of turn.')); return; }
    if (line.startsWith('S:') && FILETIME.test(line.slice(2))) this.settle(job, null, { start: line.slice(2) });
    else if (line === 'E:N') this.settle(job, null, { missing: true });
    else if (line === 'E:F') this.settle(job, permanent('Windows refused the process check.'));
    else this.lost(helper, transient('The process check helper returned malformed output.'), job);
    this.pump();
  }

  // Every waiting query fails with the helper; the caller's retry policy paces any restart.
  lost(helper, error, job) {
    if (this.child !== helper) { if (job) this.settle(job, error); return; }
    this.child = null;
    helper.child.kill();
    if (job) this.settle(job, error);
    this.failAll(error);
  }

  failAll(error) {
    const pending = [this.active, ...this.queue.splice(0)].filter(Boolean);
    this.active = null;
    for (const job of pending) this.settle(job, error);
  }

  pump() {
    if (this.active) return;
    if (!this.queue.length) {
      clearTimeout(this.idleTimer);
      if (this.child) {
        this.child.child.unref?.();
        this.idleTimer = setTimeout(() => this.stop(), this.idleMs);
        this.idleTimer.unref?.();
      }
      return;
    }
    if (!this.child) { this.start(); if (!this.child) return; }
    this.child.child.ref?.();
    if (!this.child.ready) return;
    const job = this.queue.shift();
    this.active = job;
    this.child.child.stdin.write(`${job.pid}\n`);
  }

  stop() {
    clearTimeout(this.idleTimer);
    const helper = this.child;
    this.child = null;
    if (helper) {
      helper.child.stdin?.end();
      helper.child.kill();
    }
    this.failAll(transient('The process check was stopped.'));
  }
}

let windowsHelper = null;

/** Stop the Windows helper, for example when the MCP server shuts down. */
export function stopProcessProbe() {
  windowsHelper?.stop();
  windowsHelper = null;
}

function macProcessStart(pid, signal) {
  return new Promise((resolve, reject) => {
    execFile('/bin/ps', ['-o', 'lstart=', '-p', String(pid)],
      { encoding: 'utf8', maxBuffer: 16_384, signal, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } },
      (error, stdout) => {
        if (!error) { resolve({ start: String(stdout).trim() }); return; }
        if (error.code === 'ENOENT') reject(permanent('/bin/ps is unavailable.'));
        // ps exits with 1 and prints nothing when no process has the PID.
        else if (error.code === 1 && !String(stdout).trim()) resolve({ missing: true });
        else reject(transient('ps did not answer.'));
      });
  });
}

/** Ask the OS for a process's creation token: { start } or { missing: true }. Throws an error marked
 * `transient` when another attempt may succeed, and `permanent` when the check cannot run here. */
export function readProcessStart(pid, { platform = process.platform, signal } = {}) {
  if (platform === 'win32') {
    windowsHelper ??= new WindowsProcessHelper();
    return windowsHelper.query(pid, signal);
  }
  return macProcessStart(pid, signal);
}

/** For tests of the helper protocol only. */
export const testing = { WindowsProcessHelper };

/**
 * Verify the registry's creation token against the actual local process. A confirmed change or exit
 * fails at once; a check that cannot finish is retried within the call deadline and then reported as
 * unverified, never as a change. The injectable probe and platform keep policy tests independent of
 * the host. `kind` on the thrown error: invalid, changed, exited, unverified or unavailable.
 */
export async function verifyClaudeProcess(record, { platform = process.platform, hostName = hostname(),
  probe = readProcessStart, signal } = {}) {
  if (!['win32', 'darwin'].includes(platform)) {
    throw failure('The bridge cannot verify a Claude Code conversation on this operating system. Use Windows or macOS.',
      'identity_check_unavailable', { kind: 'unavailable' });
  }
  const expectedDomain = platform === 'win32' ? `win32:${hostName.toLowerCase()}` : 'darwin';
  if (!Number.isSafeInteger(record.pid) || record.pid <= 0 || record.pidDomain !== expectedDomain ||
      typeof record.procStart !== 'string' || !record.procStart ||
      (platform === 'win32' && !FILETIME.test(record.procStart))) {
    throw Object.assign(new Error('The Claude Code registration is for another computer or has invalid creation metadata.'),
      { kind: 'invalid' });
  }
  const format = platform === 'win32' ? FILETIME : PS_LSTART;
  let result;
  try {
    result = await inquire(async ({ signal: attempt }) => {
      const answer = await probe(record.pid, { platform, signal: attempt });
      if (answer?.missing === true) return answer;
      const start = typeof answer?.start === 'string' ? answer.start.trim() : '';
      if (!format.test(start)) throw transient('The process check returned malformed output.');
      return { start };
    }, { signal });
  } catch (error) {
    if (error.code === 'ABORT_ERR' || error.code === 'BRIDGE_OUTPUT_BUSY') throw error;
    if (error.code === 'BRIDGE_DEADLINE' || error.transient || error.inconclusive) {
      throw Object.assign(new Error('Could not verify the Claude Code process in time.'), { kind: 'unverified' });
    }
    throw Object.assign(new Error('The Claude Code process check cannot run on this computer.'), { kind: 'unavailable' });
  }
  if (result.missing) throw Object.assign(new Error('The Claude Code process has exited.'), { kind: 'exited' });
  if (result.start !== record.procStart) {
    throw Object.assign(new Error('The running process does not match the Claude Code registration.'), { kind: 'changed' });
  }
}
