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

The installer needs the `claude` and `codex` CLIs for the applications you select (`--claude` or `--codex` for one; `--prepare-only` stages files without installing). It stages the native runtime under `~/plugins/bridge-claude-codex`, installs the plugin through both CLIs, and backs up any file it changes. Run it from a Codex Desktop task when you can: it then also registers the running Desktop for discovery from Claude. Run it again after pulling updates.

For Claude it also adds exactly one rule to `permissions.allow` in the user `settings.json`: `mcp__plugin_bridge-claude-codex_bridge-claude-codex__send_to_codex`, because Desktop's Auto mode may block that tool as an external write. Existing `deny` and `ask` rules keep precedence.

Alternatively, install from this repository's Git marketplace. That route does not add the Claude permission; add the tool in `/permissions` yourself.

```powershell
claude plugin marketplace add https://github.com/KeeVeeG/claude-codex-bridge.git
claude plugin install bridge-claude-codex@keeveeg --scope user
codex plugin marketplace add https://github.com/KeeVeeG/claude-codex-bridge.git
codex plugin add bridge-claude-codex@keeveeg
```

After installing or updating, load the new server in each client:

- **Claude Code CLI:** `/reload-plugins`, then check `/mcp`. If it warns that the conversation would be re-read, the reload is held: run `/reload-plugins --force`.
- **Claude Desktop:** fully quit it, including the background instance, and reopen.
- **Codex Desktop:** fully quit the app, not only its window, and reopen it. Until then new tasks still start the old version.
- **Codex CLI:** restart the session.

A visible bridge skill does not mean its MCP server connected; if the tools are missing, read the server's startup error in `/mcp`.

### Updating from a version before 1.0.0

Version 1.0.0 renamed the plugin from `codex-claude-desktop-bridge` to `bridge-claude-codex`. The installer replaces the old registrations and preserves the allow, ask, or deny choices in your Claude permission rules. Current versions do **not** move the delivery ledger automatically: a running older server can recreate its former path and accept an ID a second time.

1. Fully quit both apps and stop any other bridge servers or installers. Back up `~/.local/share/codex-claude-desktop-bridge` and `~/.local/share/claude-codex-bridge` if they exist.
2. If only the old directory exists, either move it to the current name while everything is stopped or set `CLAUDE_CODEX_BRIDGE_STATE_DIR` to the old directory in both apps. If both directories exist and are separate, compare their records with the receiving conversations before choosing one ledger. Keep both backups; do not resend to reconcile them. Before restarting, archive the unused directory outside the two default locations or pin both apps to a separate reconciled directory.
3. Update and restart both clients. Replace old `CODEX_CLAUDE_BRIDGE_*` settings with `CLAUDE_CODEX_BRIDGE_*` in the current clients. `bridge_doctor` reports state setup and legacy settings.

For a mixed run or rollback, point every process at the **same real private directory** before starting it; pre-1.0 readers use `CODEX_CLAUDE_BRIDGE_STATE_DIR`. If keeping the old folder, explicitly pin 1.0.x too: an unpinned 1.0.x process can still move it. Sharing delivery records does not make older transport features compatible. In particular, v0.2.0 and earlier can overwrite a multi-host registry with one entry. Do not roll back to v0.1.0 and retry a delivery: that release uses pairing-based keys and cannot recognize routed receipts even on the same disk. Stop all writers and reconcile affected delivery IDs against the receiving conversations before any rollback sends; see [local records](docs/PRIVACY.md#local-records).

### macOS SSH host

1. Add an authenticated alias to `~/.ssh/config`; Codex must be installed and signed in on that host. A loopback alias works too.
2. In Codex Desktop, connect through **Settings > Connections > SSH** and open the target chat on that connection. A chat under **This computer** belongs to a different server.
3. Install with the alias, and use the same alias on later updates: `CLAUDE_CODEX_BRIDGE_SSH_HOST=my-codex-host node scripts/install.mjs`. Marketplace installs must configure this variable themselves.

`list_codex_threads` then lists only that server's loaded chats (`source: "ssh"`), and `send_to_codex` accepts only `auto` or `ssh`. The target must be loaded and idle. The bridge never resumes or creates threads, never falls back to a local route, and never retries a submitted turn. Transport security is described in [SECURITY.md](SECURITY.md).

## Usage

| Tool | Purpose |
| --- | --- |
| `list_claude_sessions` | Local Claude Code sessions with their exact `session_id`, title, working directory, client, and status. |
| `list_codex_threads` | Codex threads with their exact `thread_id`; optional `limit` 1–50 per source. Source failures arrive as `warnings`. |
| `send_to_claude` | Send `message` to `session_id`. |
| `send_to_codex` | Send `message` to `thread_id`; optional `transport`: `auto`, `desktop`, `terminal`, or `ssh`. |
| `list_deliveries` | Your recent outgoing deliveries (`limit` 1–100); read-only. |
| `bridge_doctor` | Check transports, caller identity, and state without sending anything. From a Codex Desktop task it also registers that task for discovery from Claude. |
| `bridge_panel` | Codex Desktop only: open a panel beside the current chat to browse Claude conversations and message them by hand. |

`panel_history`, `panel_send`, and `panel_retry_notice` serve the panel.

From Claude, find a thread with `list_codex_threads` and call `send_to_codex`; from Codex, find a session with `list_claude_sessions` and call `send_to_claude`. A known exact ID can be used directly. One conversation can message several others. Claude lists terminal (`cli`), print-mode (`sdk-cli`), Desktop (`claude-desktop`), and VS Code (`claude-vscode`) sessions; choose by exact ID, and list again after `/clear` or `/resume`. A session is reachable only while its process runs; print-mode sessions only until they exit. A session open in two windows, for example resumed in a new terminal while the old one still runs, gets messages in the window used last.

Incoming messages name their verified source, so a reply is just another `send_*` call to that ID. They are collaborator context, not instructions from the user.

**Delivery.** Both send tools return `{ delivery, outcome }`; `list_deliveries` returns `{ application, sender_id, deliveries }`. Each delivery contains `message_id`, `from` and `to` endpoints (`app`, `id`, optional `host_id`), `message`, `status`, `created_at`, and optional `manual`, `updated_at`, and human-readable `error`. Internal transport receipts are not exposed. `outcome` is `{ delivered, retry, reason, record? }`: `delivered` is `true`, `false` or `"unknown"`; `retry` is `same_id` (repeat the identical call), `after_fix` (fix the stated cause, then repeat it), `inspect` (check the recipient and `list_deliveries` before any further send), `new_id` or `no`; `reason` is a stable code. A failed call carries the same object as a second text block after its message and in `_meta["bridge-claude-codex/outcome"]`.

`submitted` means handed to the receiving application, not read. An optional `message_id` (1–100 ASCII letters, digits, `_`, `-`; not a JavaScript built-in name such as `constructor`) makes a repeated call safe: from the same conversation, with the same recipient, ID, and text, it never delivers twice and reports the earlier outcome instead, even after the recipient has closed. Nothing is resent automatically. A send that failed before anything was written (the recipient was busy or not reachable, or the call ran out of time) can be repeated with the same ID and text once the cause is fixed. An uncertain send may still arrive, so check the destination and `list_deliveries` before sending it again under a new ID; never reuse an ID for different text. Cancelling a call before its write sends nothing; after the write it marks the send `uncertain`, and nothing can be recalled. Tool calls have a 55-second deadline from receipt, including time spent waiting behind another send. Local state-file work can delay a reply; nobody has a deadline to answer a message.

**Conversation panel.** Codex Desktop can show MCP App panels, so the bridge offers one there. It lists the Claude conversations this Codex chat has exchanged messages with and all discoverable local ones, shows the bridge messages exchanged with the selected one, and lets you send manually. A manual send also adds a short notice to the owning Codex chat. Enter behavior follows Codex's `desktop.composerEnterBehavior`. The panel needs a local Codex Desktop chat in a host with MCP Apps support; the macOS SSH route does not provide it. `ui/bridge.html#demo` previews it with labelled fixture data.

### Codex transports on Windows

`list_codex_threads` merges Desktop discovery with the Codex daemon, which lists conversations from every client. `source` says where an entry was discovered, not where it is open now. `send_to_codex` routes by `transport`:

- `auto` (default): a conversation loaded in the daemon goes through the daemon; one the daemon does not know, or any conversation when the daemon is unavailable, goes through Desktop. A stored but unloaded conversation is ambiguous, so the bridge refuses and asks for an explicit transport.
- `desktop`: Desktop app-tools only.
- `terminal`: the daemon for loaded conversations; `codex queue` for unloaded ones or when the daemon is unavailable. The queue delivers to an open session or holds the message until the session reopens. Queued text, including the bridge's peer notice, is limited to 16000 characters. IDs the daemon does not know are refused.

Terminal messages arrive as a user turn wrapped in a peer notice; a session in mid-turn is steered without interruption. The bridge never starts the daemon. Set `CLAUDE_CODEX_BRIDGE_DAEMON=off` to disable the daemon and queue routes, and `CLAUDE_CODEX_BRIDGE_CODEX_BIN` to the path of `codex.exe` if it is not found on `PATH` or through an npm, pnpm, or Volta shim.

## Troubleshooting

Run `bridge_doctor` first; it sends nothing. From a verified Codex Desktop task it also refreshes discovery registration.

- **Codex Desktop not found from Claude.** Codex Desktop's bridge server registers its endpoint when it starts, with the last registered task, and again whenever a task sends or calls `bridge_doctor`. The registry keeps recent endpoints and drops those whose pipe is gone. The error names the cause:
  - *running but did not answer in time*: Codex Desktop is stuck; restart it.
  - *rejected saved task context*: the registered task was removed; call `bridge_doctor` once from an open Codex Desktop task.
  - *belongs to earlier Codex Desktop launches* only: open a Codex Desktop task with the bridge enabled.
- **Each app sees different state.** Both must resolve to one real directory, normally `~/.local/share/claude-codex-bridge`. The installer pins the local directory for both, avoiding Windows MSIX virtualization of `LOCALAPPDATA`. If old and new state both exist, follow the update steps above before retrying any delivery.
- **Claude blocks `send_to_codex`.** Add the permission above, or switch the Code tab to **Manual** and approve the prompt. A `Bash` rule does not apply to MCP tools.
- **Claude does not receive.** `/status` must show a `Peer address`; `--bare` sessions have no inbox. Claude's `crossSessionInbound` setting can hold or refuse messages after a successful write. The bridge marks its messages `from-mode="bypass"` so Bypass sessions do not hold them silently ([issue #1](https://github.com/KeeVeeG/claude-codex-bridge/issues/1)); it never changes your inbound settings.

## Compatibility

Validated locally with Claude Desktop 2.7032.0.0, Claude Code 2.1.284–2.1.299, Codex backend 0.155.0-alpha.16.3 with `codex-app-tools` 0.1.4, and Codex CLI/daemon 0.162.1. These are observed versions, not a guarantee: the bridge relies on private application interfaces that can change. The macOS route was smoke-tested by the author of [PR #2](https://github.com/KeeVeeG/claude-codex-bridge/pull/2) before later changes; the merged version is covered only by simulated transport tests.

## Security and privacy

Every local process of the same OS user can reach these endpoints, which is the bridge's trust boundary. A message to a session running with approvals off could be acted on; the peer notice asks the receiver to confirm consequential actions but cannot enforce it. Credentials stay local and never enter messages. Message text and delivery records are stored locally: see [PRIVACY.md](docs/PRIVACY.md) and [SECURITY.md](SECURITY.md).

## Development

```powershell
npm run manifests:sync
npm run manifests:check
npm test
```

Tests use temporary registries and simulated endpoints and never touch your live conversations; scratch output stays in the ignored `work/` directory. Protocol adapters live in `lib/claude-sessions.mjs`, `lib/codex-desktop.mjs`, `lib/codex-daemon.mjs`, and `lib/codex-ssh.mjs`; `lib/bridge-service.mjs` routes messages and `lib/store.mjs` keeps delivery records. Edit the canonical root files, then run `npm run manifests:sync` to regenerate `compatibility/native/`. Packaging, manifests, and releases are described in [docs/PUBLISHING.md](docs/PUBLISHING.md); the agent-side workflow is in [skills/bridge](skills/bridge/SKILL.md).

## License

[MIT](LICENSE) — Copyright © 2026 KeeVeeG. An independent project, not affiliated with or endorsed by OpenAI or Anthropic.
