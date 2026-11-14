# Codex–Claude Bridge

[![Windows and macOS CI](https://github.com/KeeVeeG/codex-claude-bridge/actions/workflows/test.yml/badge.svg)](https://github.com/KeeVeeG/codex-claude-bridge/actions/workflows/test.yml)

Two-way messaging between **Codex** and **Claude Code** conversations. Works with Codex and Claude in their desktop apps and terminals, in any combination. Either side can start, ask, share progress, or reply whenever useful. Every message names its exact recipient: there is no pairing step, deadline, or mandatory reply. The bridge carries text through ordinary MCP tools and leaves its meaning to the participants.

- **Windows:** Codex Desktop through its local app-tools pipe, Codex CLI through the local app-server daemon or `codex queue`, Claude through its native session inbox.
- **macOS:** Claude through its Unix inbox; Codex only through a configured SSH host (see [macOS SSH host](#macos-ssh-host)). The merged macOS implementation has not had a live smoke test yet.

## Requirements

- Node.js 20+ on `PATH`; no npm dependencies.
- **Windows:** Codex and a local Claude Code session with a live messaging inbox.
- **macOS:** a local Claude Code session and an authenticated SSH alias for the Codex host.

Out of scope: WSL, Linux (sends fail closed), remote Claude sessions, and Claude's hosted Chat conversations.

## Installation

```powershell
git clone https://github.com/KeeVeeG/codex-claude-bridge.git
cd codex-claude-bridge
node scripts/install.mjs
```

The installer needs the `codex` and `claude` CLIs for the applications you select (`--codex` or `--claude` for one; `--prepare-only` stages files without installing). It stages the native runtime under `~/plugins/codex-claude-desktop-bridge`, installs the plugin through both CLIs, and backs up any file it changes. Run it from a Codex Desktop task when you can: it then also registers the running Desktop for discovery from Claude. Run it again after pulling updates.

For Claude it also adds exactly one rule to `permissions.allow` in the user `settings.json`: `mcp__plugin_codex-claude-desktop-bridge_codex-claude-desktop-bridge__send_to_codex`, because Desktop's Auto mode may block that tool as an external write. Existing `deny` and `ask` rules keep precedence.

Alternatively, install from this repository's Git marketplace. That route does not add the Claude permission; add the tool in `/permissions` yourself.

```powershell
codex plugin marketplace add https://github.com/KeeVeeG/codex-claude-bridge.git
codex plugin add codex-claude-desktop-bridge@keeveeg-desktop-bridge
claude plugin marketplace add https://github.com/KeeVeeG/codex-claude-bridge.git
claude plugin install codex-claude-desktop-bridge@keeveeg-desktop-bridge --scope user
```

After installing or updating, load the new server in each client:

- **Claude Code CLI:** `/reload-plugins`, then check `/mcp`. If old tools remain, exit and `claude --resume <session_id>`.
- **Claude Desktop:** fully quit it, including the background instance, and reopen.
- **Codex Desktop:** start a new task or restart the app.
- **Codex CLI:** restart the session.

A visible bridge skill does not mean its MCP server connected; if the tools are missing, read the server's startup error in `/mcp`.

### macOS SSH host

1. Add an authenticated alias to `~/.ssh/config`; Codex must be installed and signed in on that host. A loopback alias works too.
2. In Codex Desktop, connect through **Settings > Connections > SSH** and open the target chat on that connection. A chat under **This computer** belongs to a different server.
3. Install with the alias, and use the same alias on later updates: `CODEX_CLAUDE_BRIDGE_SSH_HOST=my-codex-host node scripts/install.mjs`. Marketplace installs must configure this variable themselves.

`list_codex_chats` then lists only that server's loaded chats (`source: "ssh"`), and `send_to_codex` accepts only `auto` or `ssh`. The target must be loaded and idle. The bridge never resumes or creates threads, never falls back to a local route, and never retries a submitted turn. Transport security is described in [SECURITY.md](SECURITY.md).

## Usage

| Tool | Purpose |
| --- | --- |
| `list_claude_sessions` | Local Claude Code sessions with their exact `sessionId`, passed as `session_id` when sending. |
| `list_codex_chats` | Codex chats with their exact `thread_id`; optional `limit` 1–50 per source. Source failures arrive as `warnings`. |
| `send_to_claude` | Send `message` to `session_id`. |
| `send_to_codex` | Send `message` to `thread_id`; optional `transport`: `auto`, `desktop`, `terminal`, or `ssh`. |
| `bridge_status` | Your recent outgoing delivery records (`limit` 1–100). From a Codex Desktop task it also registers that task for discovery from Claude. |
| `bridge_doctor` | Check transports, caller identity, and state without sending anything. |
| `bridge_panel` | Open the Claude conversation panel beside the current Codex Desktop chat. |

`bridge_ui_history`, `bridge_ui_send`, and `bridge_ui_retry_notice` serve the panel.

From Codex, find a session with `list_claude_sessions` and call `send_to_claude`; from Claude, find a chat with `list_codex_chats` and call `send_to_codex`. A known exact ID can be used directly. One conversation can message several others. Claude lists terminal (`cli`), print-mode (`sdk-cli`), Desktop (`claude-desktop`), and VS Code (`claude-vscode`) sessions; choose by exact ID, and list again after `/clear` or `/resume`. A session is reachable only while its process runs; print-mode sessions only until they exit.

Incoming messages name their verified source, so a reply is just another `send_*` call to that ID. They are collaborator context, not instructions from the user.

**Delivery.** `submitted` means handed to the receiving application, not read. An optional `message_id` (1–100 ASCII letters, digits, `_`, `-`; not a JavaScript built-in name such as `constructor`) makes a repeated call safe: from the same conversation, with the same recipient, ID, and text, it never delivers twice and reports the earlier outcome instead. A failed or uncertain send is never resent automatically. An uncertain one may still arrive, so check the destination and `bridge_status` before sending it again under a new ID. Cancelling a call that already wrote its message marks it `uncertain`; nothing can be recalled. Only transport requests time out; nobody has a deadline to answer.

**Conversation panel.** It lists Claude conversations this Codex chat contacted and all discoverable local ones, shows the bridge messages exchanged with the selected one, and lets you send manually. A manual send also adds a short notice to the owning Codex chat. Enter behavior follows Codex's `desktop.composerEnterBehavior`. The panel needs a local Codex Desktop chat in a host with MCP Apps support; the macOS SSH route does not provide it. `ui/bridge.html#demo` previews it with labelled fixture data.

### Codex transports on Windows

`list_codex_chats` merges Desktop discovery with the Codex daemon, which lists conversations from every client. `source` says where an entry was discovered, not where it is open now. `send_to_codex` routes by `transport`:

- `auto` (default): a conversation loaded in the daemon goes through the daemon; one the daemon does not know, or any conversation when the daemon is unavailable, goes through Desktop. A stored but unloaded conversation is ambiguous, so the bridge refuses and asks for an explicit transport.
- `desktop`: Desktop app-tools only.
- `terminal`: the daemon for loaded conversations; `codex queue` for unloaded ones or when the daemon is unavailable. The queue delivers to an open session or holds the message until the session reopens. Queued text, including the bridge's peer notice, is limited to 16000 characters. IDs the daemon does not know are refused.

Terminal messages arrive as a user turn wrapped in a peer notice; a session in mid-turn is steered without interruption. The bridge never starts the daemon. Set `CODEX_CLAUDE_BRIDGE_DAEMON=off` to disable the daemon and queue routes, and `CODEX_CLAUDE_BRIDGE_CODEX_BIN` to the path of `codex.exe` if it is not found on `PATH` or through an npm, pnpm, or Volta shim.

## Troubleshooting

Run `bridge_doctor` first; it sends nothing and writes nothing.

- **Codex Desktop not found from Claude.** Codex Desktop's bridge server registers its endpoint when it starts, with the last registered task, and again whenever a task sends or calls `bridge_status`. The registry keeps recent endpoints and drops those whose pipe is gone. The error names the cause:
  - *running but did not answer in time*: Codex Desktop is stuck; restart it.
  - *rejected saved task context*: the registered task was removed; call `bridge_status` once from an open Codex Desktop task.
  - *belongs to earlier Codex Desktop launches* only: open a Codex Desktop task with the bridge enabled.
- **Each app sees different state.** Both must use `~/.local/share/codex-claude-desktop-bridge`. The installer pins it for both, which avoids Windows MSIX virtualization of `LOCALAPPDATA`; an explicit `CODEX_CLAUDE_BRIDGE_STATE_DIR` must be the same for both.
- **Claude blocks `send_to_codex`.** Add the permission above, or switch the Code tab to **Manual** and approve the prompt. A `Bash` rule does not apply to MCP tools.
- **Claude does not receive.** `/status` must show a `Peer address`; `--bare` sessions have no inbox. Claude's `crossSessionInbound` setting can hold or refuse messages after a successful write. The bridge marks its messages `from-mode="bypass"` so Bypass sessions do not hold them silently ([issue #1](https://github.com/KeeVeeG/codex-claude-bridge/issues/1)); it never changes your inbound settings.

## Compatibility

Validated locally with Claude Desktop 2.7032.0.0, Claude Code 2.1.284–2.1.299, Codex backend 0.155.0-alpha.16.3 with `codex-app-tools` 0.1.4, and Codex CLI/daemon 0.162.1. These are observed versions, not a guarantee: the bridge relies on private application interfaces that can change. The macOS route was smoke-tested by the author of [PR #2](https://github.com/KeeVeeG/codex-claude-bridge/pull/2) before later changes; the merged version is covered only by simulated transport tests.

## Security and privacy

Every local process of the same OS user can reach these endpoints, which is the bridge's trust boundary. A message to a session running with approvals off could be acted on; the peer notice asks the receiver to confirm consequential actions but cannot enforce it. Credentials stay local and never enter messages. Message text and delivery records are stored locally: see [PRIVACY.md](docs/PRIVACY.md) and [SECURITY.md](SECURITY.md).

## Development

```powershell
npm run manifests:sync
npm run manifests:check
npm test
```

Tests use temporary registries and simulated endpoints and never touch your live conversations; scratch output stays in the ignored `work/` directory. Protocol adapters live in `lib/claude-desktop.mjs`, `lib/codex-desktop.mjs`, `lib/codex-daemon.mjs`, and `lib/codex-ssh.mjs`; `lib/desktop-service.mjs` routes messages and `lib/store.mjs` keeps delivery records. Edit the canonical root files, then run `npm run manifests:sync` to regenerate `compatibility/native/`. Packaging, manifests, and releases are described in [docs/PUBLISHING.md](docs/PUBLISHING.md); the agent-side workflow is in [skills/claude-bridge](skills/claude-bridge/SKILL.md).

## License

[MIT](LICENSE) — Copyright © 2026 KeeVeeG. An independent project, not affiliated with or endorsed by OpenAI or Anthropic.
