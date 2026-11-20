# Claude–Codex Bridge

[![Windows and macOS CI](https://github.com/KeeVeeG/claude-codex-bridge/actions/workflows/test.yml/badge.svg)](https://github.com/KeeVeeG/claude-codex-bridge/actions/workflows/test.yml)

Two-way messaging between **Claude Code** and **Codex** conversations. Works with Claude and Codex in their desktop apps and terminals, in any combination. Either side can start, ask, share progress, or reply whenever useful. Every message names its exact recipient: there is no pairing step, deadline, or mandatory reply. The bridge carries text through ordinary MCP tools and leaves its meaning to the participants.

- **Windows:** Claude through its native session inbox; Codex Desktop through its local app-tools pipe, Codex CLI through the local app-server daemon or `codex queue`.
- **macOS:** Claude through its Unix inbox; Codex only through a configured SSH host (see [macOS SSH host](#macos-ssh-host)). The merged macOS implementation has not had a live smoke test yet.

## Requirements

- Node.js 20+ on `PATH`; no npm dependencies.
- **Windows:** a local Claude Code session with a live messaging inbox, and Codex.
- **macOS:** a local Claude Code session and an authenticated SSH alias for the Codex host.

Out of scope: WSL, Linux (sends fail closed), remote Claude sessions, and Claude's hosted Chat conversations.

## Installation

```powershell
git clone https://github.com/KeeVeeG/claude-codex-bridge.git
cd claude-codex-bridge
node scripts/install.mjs
```

You can also unpack the native plugin ZIP into its own directory and run `node scripts/install.mjs` from there. The installer needs the CLI for each application you select (`--claude` or `--codex` for just one; `--prepare-only` prepares a stage without invoking either CLI or granting tool permissions; current Claude Code loads the installer's stage in place, so it picks up a prepared stage at its next start or reload). On Windows, Claude needs its native `claude.exe`; for Codex see the [executable settings](#codex-transports-on-windows). The installer stages the native runtime under `~/plugins/bridge-claude-codex`. It will not replace a source checkout, manual install, or unknown directory there; use a separate source directory and move an existing tree yourself only after you identify it and stop its users. [Installer backups](docs/PRIVACY.md#installer-backups) are separate from bridge state. Run from a Codex Desktop task when you can: it can also register the running Desktop for discovery from Claude.

For Claude it also adds exactly one rule to `permissions.allow` in the user `settings.json`: `mcp__plugin_bridge-claude-codex_bridge-claude-codex__send_to_codex`, because Desktop's Auto mode may block that tool as an external write. Existing `deny` and `ask` rules keep precedence.

Alternatively, install from this repository's Git marketplace. That route does not add the Claude permission; add the tool in `/permissions` yourself.

```powershell
claude plugin marketplace add https://github.com/KeeVeeG/claude-codex-bridge.git
claude plugin install bridge-claude-codex@keeveeg --scope user
codex plugin marketplace add https://github.com/KeeVeeG/claude-codex-bridge.git
codex plugin add bridge-claude-codex@keeveeg
```

To update, run the installer again from the updated checkout or native ZIP with the same route settings. For a marketplace installation, update the marketplace and plugin through each client's plugin manager. Use one source per client: while another source's `bridge-claude-codex` is turned on in a client, the installer changes nothing and names the command that removes or turns off that registration.

- **Before updating 1.0.0–1.0.2 with the installer**, fully quit Claude and Codex, including terminal sessions, before you run it: those servers load code from the staged folder the installer replaces, so a running one could mix versions. If you are not sure which version or source you have, quit them first as well.
- **Turned-off plugins:** Codex has no update command that keeps a plugin turned off. If you turned the bridge off, the installer stops before updating either client. Use `--claude` to update Claude alone. When you want to use the Codex bridge again, turn it on and rerun the installer. Adding it from a Codex marketplace also turns it on; after a marketplace update, turn it off again in Codex to keep that choice. Claude keeps a disabled plugin disabled when it updates.
- **Client caches:** keep local edits outside `plugins/cache` in the Codex home or Claude configuration directory. A Codex update replaces its cached copy; Claude can keep the old version, but the new version does not include your edits. If Codex's cached copy differs from every verified installer stage, the installer stops and names the folder to move. A marketplace update makes no such check.
- **Failed updates:** if an update fails after a client took the new version, the installer refreshes a client only from a stage matching the files it ran before. When it cannot restore those files, the error names each client's version before and after, and the folder holding its previous files or, if none was kept, that version's release package. An installer lock left by a stopped installer is named with its own [recovery step](#offline-lock-recovery).

Then load the new server in each client:

- **Interactive Claude Code CLI:** run `/reload-plugins`, then check `/mcp`. If it warns that the conversation would be re-read, run `/reload-plugins --force` to apply the pending reload. If it still shows the old server, restart the session.
- **Claude Desktop:** fully quit it, including the background instance, and reopen. A non-interactive Claude Code session needs a new session to reconnect plugin MCP servers.
- **Codex Desktop:** fully quit the app, not only its window, and reopen it. Until then new tasks can still start the old version.
- **Codex CLI:** restart the session.

A visible bridge skill does not mean its MCP server connected. If the tools are missing, see [Troubleshooting](#troubleshooting).

### Uninstall

1. In each client, remove only the bridge plugin entry with the marketplace and scope shown by that client. For a local installer Claude registration, use `claude plugin uninstall bridge-claude-codex@claude-codex-local --scope user`. For Codex, use `codex plugin remove` with the exact `bridge-claude-codex@…` ID. Reload or restart as above. Remove a marketplace only if you no longer need any of its entries.
2. If you used the installer, optionally remove just the `bridge-claude-codex` entry pointing to the stage in the personal Codex catalog (`~/.agents/plugins/marketplace.json`), and remove the exact Claude allow rule shown above if you no longer want it. Keep other entries and rules. A client uninstall does not delete the source checkout or the locally staged files. Remove the staged directory yourself only if you know it is your bridge installation and no client still uses it.
3. Uninstalling does not erase messages. To remove local records or installer backups, see [Privacy and local data](docs/PRIVACY.md).

### Updating from a version before 1.0.0

Version 1.0.0 renamed the plugin from `codex-claude-desktop-bridge` to `bridge-claude-codex`. The installer registers the replacement before retiring verified legacy user registrations. It leaves unverified sources and other scopes in place for you to review in the owning client, and preserves the allow, ask, or deny choices in your Claude permission rules. Current versions do **not** move the delivery ledger automatically: a running older server can recreate its former path and accept an ID a second time.

1. Fully quit both apps and stop any other bridge servers or installers. Back up `~/.local/share/codex-claude-desktop-bridge` and `~/.local/share/claude-codex-bridge` if they exist.
2. If only the old directory exists, either move it to the current name while everything is stopped or set `CLAUDE_CODEX_BRIDGE_STATE_DIR` to the old directory in both apps. If both directories exist and are separate, compare their records with the receiving conversations before choosing one ledger. Keep both backups; do not resend to reconcile them. Before restarting, archive the unused directory outside the two default locations or pin both apps to a separate reconciled directory.
3. Update and restart both clients. Replace old `CODEX_CLAUDE_BRIDGE_*` settings with `CLAUDE_CODEX_BRIDGE_*` in the current clients. `bridge_doctor` reports state setup and legacy settings.

For a mixed run or rollback, point every process at the **same real private directory** before starting it; pre-1.0 readers use `CODEX_CLAUDE_BRIDGE_STATE_DIR`. If keeping the old folder, explicitly pin 1.0.x too: an unpinned 1.0.x process can still move it. Sharing delivery records does not make older transport features compatible. In particular, v0.2.0 and earlier can overwrite a multi-host registry with one entry. Do not roll back to v0.1.0 and retry a delivery: that release uses pairing-based keys and cannot recognize routed receipts even on the same disk. Stop all writers and reconcile affected delivery IDs against the receiving conversations before any rollback sends; see [local records](docs/PRIVACY.md#local-records).

### macOS SSH host

1. Add an authenticated alias to `~/.ssh/config`; Codex must be installed and signed in on that host. A loopback alias works too.
2. In Codex Desktop, connect through **Settings > Connections > SSH** and open the target chat on that connection. A chat under **This computer** belongs to a different server.
3. Install with the alias, and use the same alias on later updates: `CLAUDE_CODEX_BRIDGE_SSH_HOST=my-codex-host node scripts/install.mjs`. Marketplace installs must configure this variable themselves.

`list_codex_threads` then lists only that server's loaded idle chats (`source: "ssh"`), and `send_to_codex` accepts only `auto` or `ssh`. Without an alias, macOS refuses Codex discovery and sends with `setup_incomplete`; it never falls back to a local route. The alias is visible to the models as `host_id: "ssh:<alias>"` in results and saved deliveries, so pick a neutral name. The target must be loaded and idle. The bridge never resumes or creates threads, never falls back to a local route, and never retries a submitted turn. Transport security is described in [SECURITY.md](SECURITY.md).

## Usage

| Tool | Purpose |
| --- | --- |
| `list_claude_sessions` | Local Claude Code sessions with their exact `session_id`, title, working directory, client, and status. |
| `list_codex_threads` | Codex threads with their exact `thread_id`; optional `limit` 1–50 per source. Source failures arrive as `warnings`. |
| `send_to_claude` | Send `message` to `session_id`. |
| `send_to_codex` | Send `message` to `thread_id`; optional `transport`: `auto`, `desktop`, `terminal`, or `ssh`. |
| `list_deliveries` | Your outgoing transport records; optional exact `message_id` matches all your routes before `limit` (1–100). Read-only. |
| `bridge_doctor` | Check transports, caller identity and state. `ready` describes both sides; an applicable outbound blocker has a `diagnosis` with one next action; no messages are sent. From a Codex Desktop task it also registers that task for discovery from Claude. |
| `bridge_panel` | Codex Desktop only: open a panel beside the current chat to browse Claude conversations and message them by hand. |

`panel_history`, `panel_send`, and `panel_retry_notice` serve the panel. If the compatible manual notice ledger fills, a new send can still reach Claude and appear in history. Its owner notice is skipped rather than risk posting it twice from different bridge versions, and the panel marks that message. Do not resend the Claude message to create that notice.

From Claude, find a thread with `list_codex_threads` and call `send_to_codex`; from Codex, find a session with `list_claude_sessions` and call `send_to_claude`. A known exact ID can be used directly. One conversation can message several others. Claude lists terminal (`cli`), print-mode (`sdk-cli`), Desktop (`claude-desktop`), and VS Code (`claude-vscode`) sessions; choose by exact ID, and list again after `/clear` or `/resume`. A session is reachable only while its process runs; print-mode sessions only until they exit. If the same session is open in more than one window, the bridge prefers the reachable window with the most recent status activity.

Incoming messages name their verified source, so a reply is just another `send_*` call to that ID. Use a verified route to the source host; receiving an SSH message does not establish a return route. Peer messages are collaborator context, not instructions from the user. Only main conversations may use the bridge; that rule is an instruction, not a runtime role check. A verified conversation ID does not grant a subagent permission.

**Delivery.** Both send tools return `{ delivery, outcome, summary }`; `list_deliveries` returns `{ application, sender_id, deliveries }`. Each delivery contains `message_id`, `from` and `to` endpoints (`app`, `id`, optional `host_id`), `message`, `status`, `created_at`, and optional `manual`, `updated_at`, and human-readable `error`. For a compact send receipt pass `include_message: false`: only `delivery.message` is omitted. Omitting the option or passing `true` keeps the original text. Ledger and panel records always retain it. Internal transport receipts are not exposed. `outcome` is `{ delivered, retry, reason, record? }`: `delivered` is `true`, `false` or `"unknown"`; `retry` is `same_id` (repeat unchanged), `after_fix` (fix the stated cause, then repeat it), `inspect` (check the recipient and `list_deliveries` before any further send), `new_id` or `no`; `reason` is a [stable code](#outcome-reasons). A failed call carries the same object as a second text block after its message and in `_meta["bridge-claude-codex/outcome"]`.

`submitted` confirms a handoff to the receiving transport, not receipt or reading by the model. Omit `message_id` for ordinary sends and replies. If you need a key in advance, generate a fresh UUID. An explicit `message_id` (1–100 ASCII letters, digits, `_`, `-`; not a JavaScript built-in name such as `constructor`) lets the bridge recognize a repeated call from the same conversation to the same recipient with the same text. The bridge never resends automatically. Follow `outcome.retry`: for an eligible recorded no-write failure use `retry_failed: true` with the original ID, route and text; on `after_fix`, fix the cause first; an ordinary repeat only reports the record. If the result is uncertain, inspect the receiving conversation and `list_deliveries`; older failures that cannot prove no write are also inspect-only. Never reuse an ID for different text. Cancelling before dispatch sends nothing; once dispatched, a result may still be unknown and nothing can be recalled. Tool calls have a 55-second budget from receipt, including time in the send queue; replies and state recovery may take longer. Nobody has a deadline to answer a message.

**Conversation panel.** Codex Desktop can show MCP App panels, so the bridge offers one there. It lists the Claude conversations this Codex chat has exchanged messages with and all discoverable local ones, shows the bridge messages exchanged with the selected one, and lets you send manually. A manual send also posts a copy of the full text in the owning Codex chat; the panel names both destinations before you send and marks each message "Handed to Claude Code", which is a write, not a read. Enter sends only when the host tells the panel that Codex sends on Enter; otherwise Enter adds a line and Ctrl+Enter (⌘+Enter on macOS) sends. On a refusal, **Retry this text** retries that exact revision without overwriting newer edits. If the owning chat changes, sending freezes; copy the draft before reopening if the host does not retain tab storage. On an unconfirmed send, **Check again** reads bridge history only; it does not submit the draft again. The Codex model sees only live sessions in the launcher result; saved titles and project folders go to the panel in widget metadata. A cached 1.0.6 panel can still work with a 1.1 server, but it lists only live sessions until the new panel loads. The panel needs a local Codex Desktop chat in a host with MCP Apps support; the macOS SSH route does not provide it. `ui/bridge.html#demo` previews it with labelled fixture data.

### Codex transports on Windows

`list_codex_threads` merges Desktop discovery with the Codex daemon, which lists conversations from every client. `source` says where an entry was discovered, not where it is open now. `send_to_codex` routes by `transport`:

- `auto` (default): a conversation loaded in the daemon goes through the daemon; one the daemon does not know, or any conversation when the daemon is unavailable, goes through Desktop. A stored but unloaded conversation is ambiguous, so the bridge refuses and asks the model to ask you whether it is open in Codex Desktop (`desktop`) or Codex CLI (`terminal`); `source` does not tell.
- `desktop`: Desktop app-tools only, on the local host: discovery skips rows of other hosts, and every send names `hostId: "local"`. A Desktop build without a host-aware message tool can still list local chats but cannot accept a send. A native access denial stops the attempt; the bridge does not try a different carrier.
- `terminal`: the daemon for loaded conversations; `codex queue` for unloaded ones or when the daemon is unavailable. The queue delivers to an open session or holds the message until the session reopens. Queued text, including the bridge's peer notice, must fit in 16,000 UTF-16 units and contain no NUL; the destination must be a UUID. A length refusal reports the excess for the formatted text in UTF-16 units. IDs the daemon does not know are refused.

Terminal messages arrive as a user turn wrapped in a peer notice; a send may steer a session’s active turn. Wait to send if the user does not want it affected. The bridge never starts the daemon. Set `CLAUDE_CODEX_BRIDGE_DAEMON=off` to disable the daemon and queue routes, and `CLAUDE_CODEX_BRIDGE_CODEX_BIN` to the path of `codex.exe` if it is not found on `PATH` or through an npm, pnpm, or Volta shim.

## Troubleshooting

Use `bridge_doctor` once for an unexplained setup, identity or transport failure, or after setup changes. It sends nothing; skip it when the error already gives the fix. From a verified Codex Desktop task it also refreshes discovery registration.

- **Codex Desktop not found from Claude.** Codex Desktop's bridge server registers its endpoint when it starts, with the last registered task, and again whenever a task sends or calls `bridge_doctor`. The registry keeps recent endpoints and drops those whose pipe is gone. The error names the cause:
  - *running but did not answer in time*: the check was inconclusive, not proof the app is stuck. Retry the read-only check.
  - *failed the discovery request*: the app could not list chats. Check Codex Desktop and retry discovery; this does not prove a task was removed.
  - *endpoint is not present*: open a Codex Desktop task with the bridge enabled.
  - *No Codex Desktop registration*: no Codex Desktop task has started the bridge with this state directory yet.

  The first sentence names the cause to fix; any further observations follow after *Also observed*.
- **Each app sees different state.** Both must resolve to one real directory, normally `~/.local/share/claude-codex-bridge`. The installer pins the local directory for both, avoiding Windows MSIX virtualization of `LOCALAPPDATA`. If old and new state both exist, follow the update steps above before retrying any delivery.
- **Claude blocks `send_to_codex`.** Add the permission above, or switch the Code tab to **Manual** and approve the prompt. A `Bash` rule does not apply to MCP tools.
- **Claude does not receive.** `/status` must show a `Peer address`; `--bare` sessions have no inbox. Claude's `crossSessionInbound` setting can hold or refuse messages after a successful write. The bridge marks its messages `from-mode="bypass"` so Bypass sessions do not hold them silently ([issue #1](https://github.com/KeeVeeG/claude-codex-bridge/issues/1)); it never changes your inbound settings. Claude sends no hold or refusal signal back, so `submitted` confirms only the transport write: check the receiving session if a message seems lost.
- **The bridge server does not start.** Check its status and startup error in the client (Claude Code: `/mcp`). The bridge refuses to start while `NODE_DEBUG` includes `child_process`, because Node would log message text and environments; remove that setting. Share the application/version, the symptom and a redacted excerpt rather than a raw host MCP cache or debug log. See [what to redact](docs/PRIVACY.md#credentials-and-diagnostics).

### Outcome reasons

A repeated ID reports its record without sending. Only a recorded, proven no-write failure can be retried with `retry_failed: true` and the original ID, route and text. A reply reports a handoff, not recipient acceptance. The reason vocabulary is closed:

| Reason | What it establishes | What to do |
|---|---|---|
| `submitted` | The transport accepted this write. | Do not resend. |
| `already_submitted` | A prior handoff is recorded. | Do not resend. |
| `settlement_failed` | The transport accepted the write but its receipt was not saved. | Restore storage access; inspect the record, don't resend. |
| `in_flight` | Another attempt is still reserved. | Wait, then inspect its record. |
| `prior_uncertain` | The prior reservation has no reliable terminal outcome. | Check the recipient and outgoing record. |
| `delivery_unconfirmed` | A write was attempted without confirmation. | Check the recipient and outgoing record. |
| `prior_failed` | A legacy failure does not establish whether it wrote. | Check the recipient before considering another send. |
| `id_conflict` | The ID names different content or origin. | Inspect the original before assigning an ID to a different message. |
| `invalid_argument` | The supplied request cannot be applied as specified. | Correct the indicated input. |
| `queued_message_too_long` | The wrapped text exceeds the native queue limit. | Shorten it; use a new ID for changed text if the original ID has a record. |
| `wrong_tool` | This caller cannot use that tool. | Use the tool for the indicated client. |
| `caller_unverified` | The sender's identity could not be verified. | Retry from the intended conversation. |
| `caller_invalid` | The calling process is not a usable registered client. | Reload the bridge in the intended client. |
| `caller_changed` | The calling conversation changed after admission. | Repeat from the intended conversation. |
| `target_unavailable` | The target cannot receive on the selected route. | Check the intended recipient; if a reserved auto route requires an explicit transport, confirm the client and use a fresh ID. |
| `target_unverified` | The recipient's identity or inbox could not be verified. | Repeat the check, without changing destinations. |
| `target_changed` | A checked destination no longer matches its registered identity. | Select the current conversation again. |
| `target_busy` | The recipient cannot accept input now. | Wait for it to become available. |
| `identity_check_unavailable` | This installation cannot perform the local process check. | Restore the supported process-check facility. |
| `route_unavailable` | The selected connection is unavailable. | Check that route's connectivity. |
| `route_unverified` | Route verification was inconclusive. | Retry the same route check. |
| `access_denied` | The native client or operating system denied access. | Resolve authorization; do not switch routes. |
| `desktop_listing_failed` | Desktop failed to list chats. | Check the application and retry discovery. |
| `ssh_auth_denied` | SSH authentication failed. | Check authorized noninteractive authentication for the alias. |
| `ssh_host_key` | SSH could not verify the host key. | Verify the host key with its operator. |
| `ssh_executable_missing` | The remote login shell cannot find Codex. | Configure its login PATH to include Codex. |
| `protocol_incompatible` | The client does not expose the required native protocol. | Check the supported client version and tools. |
| `request_rejected` | The native dispatcher rejected the request. | Correct the request before repeating it. |
| `deadline` | The call ran out of time before a write. | Retry within a fresh call budget. |
| `cancelled` | The call stopped before the write. | Retry only if the original send is still wanted. |
| `state_busy` | Another operation holds the state lock. | Wait for the operation to finish. |
| `server_busy` | The bridge's bounded request or response queue is full. | Wait for an outstanding call to finish. |
| `state_unavailable` | The required bridge state cannot be safely accessed. | Follow the stated storage recovery step before sending. |
| `setup_incomplete` | A required client or bridge setting is missing. | Complete the named setup step. |
| `version_mismatch` | Observed client/server versions differ. | Reload the indicated client. |
| `internal_error` | No more specific cause was established. | Inspect the client diagnostic before retrying. |

### Offline lock recovery

A recovery marker with no owner lock does not prevent a new acquisition. Leave it in place; doctor checks both files. If `bridge_doctor` reports interrupted recovery or an unverifiable lock that persists after an ordinary operation finishes, do not delete a lock from a running installation. Quit both apps, stop every bridge server and installer using that directory, and back up the entire state tree. Make a separate private copy on a volume that supports hard links. In the **copy only**, omit `state.lock` and `state.lock.recovery`; keep all ledger, manual, clock and other data files. Pin both apps (and any older writers) to that one copy before restarting. Run doctor and inspect saved deliveries and receiving conversations. A `sending` or `uncertain` row is not proof that nothing arrived. If you cannot establish that all writers are stopped or which state tree is authoritative, leave the originals untouched.

The installer's own locks are not bridge state, and copying or re-pinning state does not clear them: `.bridge-claude-codex-install-lock` in `~/plugins`, `.bridge-claude-codex-marketplace-lock` in `~/.agents/plugins`, and `.bridge-claude-codex-permissions-lock` in the Claude configuration directory. If the installer reports one as left by a stopped installer or as unverifiable, stop every bridge installer, check the files the message names (the staged files, the personal catalog or Claude `settings.json`), then delete only the named lock folder and run the installer again. Never delete it while an installer runs.

## Compatibility

Validated locally with Claude Desktop 2.7032.0.0, Claude Code 2.1.284–2.1.299, Codex backend 0.155.0-alpha.16.3 with `codex-app-tools` 0.1.4, and Codex CLI/daemon 0.162.1. These are observed versions, not a guarantee: the bridge relies on private application interfaces that can change. The macOS route was smoke-tested by the author of [PR #2](https://github.com/KeeVeeG/claude-codex-bridge/pull/2) before later changes; the merged version is covered only by simulated transport tests.

## Security and privacy

Every local process of the same OS user can reach these endpoints, which is the bridge's trust boundary. A message to a session running with approvals off could be acted on; the peer notice asks the receiver to confirm consequential actions but cannot enforce it. Credentials stay local and never enter messages. Message text and delivery records are stored locally: see [PRIVACY.md](docs/PRIVACY.md) and [SECURITY.md](SECURITY.md).

## Development

Use a source checkout for development, separate from the installer stage. Opening the checkout in Claude Code does not register a project MCP server. To try the changed plugin, run the local installer from your checkout or launch Claude Code with `--plugin-dir` pointing to the checkout for one session. The native marketplaces use the generated runtime, not your unsynchronized source files.

See [Releases](docs/PUBLISHING.md) for manifest synchronization, source-only test/build commands and package validation. Tests use temporary registries and simulated endpoints, not live conversations; scratch output stays in the ignored `work/` directory. The agent-side workflow is in [skills/bridge](skills/bridge/SKILL.md).

## License

[MIT](LICENSE) — Copyright © 2026 KeeVeeG. An independent project, not affiliated with or endorsed by OpenAI or Anthropic.
