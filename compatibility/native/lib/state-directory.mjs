import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { failure } from './outcome.mjs';

const currentVariable = 'CLAUDE_CODEX_BRIDGE_STATE_DIR';
const oldVariable = 'CODEX_CLAUDE_BRIDGE_STATE_DIR';
export const defaultStatePath = (homeDir = os.homedir()) => path.join(homeDir, '.local', 'share', 'claude-codex-bridge');
const legacyStatePath = homeDir => path.join(homeDir, '.local', 'share', 'codex-claude-desktop-bridge');

function lstat(directory) {
  try { return fs.lstatSync(directory, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function sameIdentity(a, b) {
  return a.ino !== 0n && a.dev === b.dev && a.ino === b.ino;
}

function inspectDirectory(directory) {
  const selected = lstat(directory);
  if (!selected) return { directory };
  const before = selected.isSymbolicLink() ? fs.statSync(directory, { bigint: true }) : selected;
  const real = fs.realpathSync.native(directory);
  const after = lstat(real);
  if (!before.isDirectory() || !after?.isDirectory() || after.isSymbolicLink() ||
      (before.ino !== 0n && !sameIdentity(before, after))) throw new Error('Invalid state directory');
  return { directory: real, identity: before };
}

function sameDirectory(a, b) {
  return a.directory === b.directory || (a.identity && b.identity && sameIdentity(a.identity, b.identity));
}

/** Resolve an explicit root (including any junction) before handing it to state readers and writers. */
export function resolveStateDirectory(directory) {
  try { return inspectDirectory(path.resolve(directory)).directory; }
  catch { throw failure('The shared state location is not a verifiable directory. Check the configured path, its link target, and your access to it.', 'state_unavailable'); }
}

const legacyPins = new Map();
const movedPin = () => failure('The pinned previous ledger moved or changed while this bridge was running. Do not recreate it or resend. Stop both apps, check which directory contains the original receipts, and pin all writers to it.', 'state_unavailable');

// A released process may rename the legacy default *after* selection. Never recursively create
// through such a pin: if it disappears between the check and mkdir of a child, ENOENT is safe.
export function ensureStateDirectory(directory) {
  const absolute = path.resolve(directory);
  let root = absolute, pin;
  while (!(pin = legacyPins.get(root))) {
    const next = path.dirname(root);
    if (next === root || !legacyPins.size) { fs.mkdirSync(absolute, { recursive: true, mode: 0o700 }); return; }
    root = next;
  }
  const verify = () => {
    const live = inspectDirectory(root), current = inspectDirectory(pin.destination);
    if (!live.identity || !sameIdentity(live.identity, pin.identity) || (current.identity && !sameDirectory(live, current))) throw movedPin();
  };
  verify();
  let current = root;
  for (const component of path.relative(root, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try { fs.mkdirSync(current, { mode: 0o700 }); }
    catch (e) { if (e.code !== 'EEXIST' || !fs.lstatSync(current).isDirectory()) throw e; }
  }
  verify();
}

const stoppedWriters = 'Fully quit both apps, stop bridge servers and installers, and back up the existing state before changing directories.';
const legacyPin = `To keep the old directory, pin ${currentVariable} to that real directory in both apps (use ${oldVariable} for pre-1.0 writers).`;

/** Never move a ledger online. Released writers can stay bound to its old path,
 * and 1.0.x can still rename a legacy-only default unless explicitly pinned away
 * from its default. A new lock or marker cannot fence either of those writers.
 */
export function defaultStateDir({ homeDir = os.homedir(), env = process.env } = {}) {
  const destination = path.resolve(defaultStatePath(homeDir));
  const source = path.resolve(legacyStatePath(homeDir));
  const configured = env[currentVariable] ? path.resolve(env[currentVariable]) : destination;
  try {
    const selected = inspectDirectory(configured);
    // A 1.0.x process can still rename the old default behind an explicit pin. A missing
    // pin is never permission to recreate that ledger. Compare the parent identity for a
    // missing Windows case alias, not a Unicode-folded absolute path.
    const legacyName = path.basename(source);
    const possibleLegacy = configured === source || selected.directory === source || (!selected.identity && process.platform === 'win32' &&
      /^[a-z-]+$/i.test(path.basename(configured)) && path.basename(configured).toLowerCase() === legacyName &&
      sameDirectory(inspectDirectory(path.dirname(configured)), inspectDirectory(path.dirname(source))));
    if (possibleLegacy) {
      if (!selected.identity) throw failure(`The pinned previous state directory is missing; an older bridge may have moved it. Do not recreate it or repeat a message. ${stoppedWriters} Check the current default and configure both apps to use the directory containing the original receipts.`, 'state_unavailable');
      const remembered = legacyPins.get(selected.directory);
      if ((remembered && !sameIdentity(remembered.identity, selected.identity)) || (!remembered && legacyPins.size >= 64)) throw movedPin();
      legacyPins.set(selected.directory, { identity: selected.identity, destination });
      const current = inspectDirectory(destination);
      if (current.identity && !sameDirectory(selected, current)) throw failure(`The old and current state directories are separate. Do not resend. ${stoppedWriters} Reconcile their receipts before selecting either copy.`, 'state_unavailable');
    }
    if (configured !== destination) {
      let normal;
      try { normal = inspectDirectory(destination); } catch { /* No known alias; honor the explicit override. */ }
      if (!normal || !sameDirectory(selected, normal)) return selected.directory;
    }
    const old = inspectDirectory(source);
    if (old.identity && !sameDirectory(old, selected)) {
      const detail = selected.identity
        ? 'The old and current default state directories are separate. Compare their delivery records with the receiving conversations. Do not resend from either copy. After reconciling, archive the unused directory outside the default locations or pin both apps to a separate reconciled directory.'
        : 'The old default state directory still exists. Move it to the current default only after all writers are stopped, or keep it and configure both apps to use it.';
      throw failure(`${detail} ${stoppedWriters}${selected.identity ? '' : ` ${legacyPin}`}`, 'state_unavailable');
    }
    if (env[oldVariable]) {
      const oldOverride = inspectDirectory(path.resolve(env[oldVariable]));
      if (!sameDirectory(oldOverride, selected)) {
        throw failure(`The old state setting points away from the current default. ${stoppedWriters} Set ${currentVariable} to the authoritative real directory in both apps. Do not retry deliveries until you have checked that ledger.`, 'state_unavailable');
      }
    }
    return selected.directory;
  } catch (error) {
    if (error.reason === 'state_unavailable') throw error;
    throw failure(`The bridge could not verify which state directory to use. Check access to the configured and previous state locations. ${stoppedWriters}`, 'state_unavailable');
  }
}

// Keep the existing doctor warning for a deliberate pin to the old default.
export function stateDirectoryWarning(directory, { homeDir = os.homedir() } = {}) {
  try {
    const previous = path.resolve(legacyStatePath(homeDir));
    if (lstat(previous)?.isDirectory() && sameDirectory(inspectDirectory(previous), inspectDirectory(path.resolve(directory)))) {
      return `The bridge uses the previous state directory. ${legacyPin} Do not start an unpinned 1.0.x process; it can still move that directory.`;
    }
  } catch { /* Selection and the state-directory check report unreadable paths. */ }
}

const run = promisify(execFile);
// Use SIDs rather than localized account names. This is a conservative ACL
// warning, not an Effective Access check (deny ACEs and group expansion vary).
const ACL_PROBE = `
$ErrorActionPreference = 'Stop'
# Read only the DACL and owner. Do not load a provider module or translate account names.
try { $acl = [IO.Directory]::GetAccessControl($env:BRIDGE_ACL_TARGET, [Security.AccessControl.AccessControlSections]'Access, Owner') }
catch { exit 11 }
$sid = [System.Security.Principal.SecurityIdentifier]
$trusted = @([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18', 'S-1-5-32-544')
$rootExists = $env:BRIDGE_ACL_PARENT -eq '0'
$raw = [System.Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
if ($null -eq $raw.DiscretionaryAcl -or ($rootExists -and $acl.GetOwner($sid).Value -notin $trusted)) { 'review'; exit }
foreach ($ace in $acl.GetAccessRules($true, $true, $sid)) {
  if ($ace.AccessControlType -ne 'Allow' -or $ace.IdentityReference.Value -in ($trusted + 'S-1-3-0')) { continue }
  $inherit = $ace.InheritanceFlags -ne 'None'
  $applies = ($ace.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0
  # List/read data, create/write/append, delete child/object, change ACL/ownership, generic rights.
  if (($inherit -or ($rootExists -and $applies)) -and ([int]$ace.FileSystemRights -band 0xF00D0047)) { 'review'; exit }
}
'clear'
`;

/** Check Windows ACL inheritance for doctor only; never modify ACLs or expose paths/SIDs in the result. */
export async function stateDirectoryPrivacyWarning(directory, { signal, timeoutMs = 2500 } = {}) {
  if (process.platform !== 'win32') return;
  const remedy = 'Use a private per-user state directory in both apps. Review Windows Properties > Security > Advanced (including inheritance and existing delivery files); stop both apps before moving state. The bridge does not change ACLs.';
  let detail = 'The state path could not be resolved.';
  try {
    const root = path.resolve(directory);
    let target = root;
    while (!lstat(target)) {
      const parent = path.dirname(target);
      if (parent === target) throw new Error('State parent not found');
      target = parent;
    }
    const real = resolveStateDirectory(target);
    detail = 'The Windows permissions probe did not complete.';
    const { stdout } = await run(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', ACL_PROBE], {
        env: { ...process.env, BRIDGE_ACL_TARGET: real, BRIDGE_ACL_PARENT: target === root ? '0' : '1' },
        maxBuffer: 4096, timeout: timeoutMs, windowsHide: true, signal,
      });
    if (stdout.trim() === 'clear') return;
    if (stdout.trim() === 'review') return `The Windows state directory or its inherited permissions may grant other accounts access to plaintext delivery records. ${remedy}`;
    detail = 'The Windows permissions probe returned an unrecognized result.';
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (error.code === 11) detail = 'Windows could not read the directory security descriptor.';
    else if (error.killed) detail = 'The Windows permissions probe timed out.';
  }
  return `The bridge could not verify the Windows state directory's permissions. ${detail} ${remedy}`;
}
