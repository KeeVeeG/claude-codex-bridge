# Security

## macOS outbound SSH route

The optional macOS route uses an operator-selected SSH config alias and Codex's app-server protocol. It retains strict host-key verification and batch authentication and never reads SSH credentials itself. The configured alias pins discovery and delivery to that server: `auto` and `ssh` use it, while `desktop` and `terminal` are rejected. Failure never falls back to a local endpoint, including a local conversation with the same ID. The bridge preserves verified Claude caller identity and its existing per-sender delivery ledger.

Only already-loaded idle threads are eligible. The bridge does not call `thread/resume`, create threads, start servers, change permissions, or retry a submitted turn. A lost reply or cancellation after transmitting a turn is recorded as uncertain and must be reconciled before a new submission. The merged macOS implementation has not yet received a new live smoke test.

## Native caller and recipient identity

Claude sessions must have a live registered process and inbox. Windows checks the native process creation identity; macOS checks process-start output from `ps` with UTC and C locale settings. The bridge caches no OS confirmation: every call asks the OS again for its caller and its recipient, on Windows through one long-lived helper process. A check that cannot finish is retried within the call's time limit and then refused as unverified, never read as a changed or exited process. Caller registration and inbox credentials are checked each time. The recipient's registration and process identity are checked at resolution and again immediately before the transport write; the native protocol cannot prevent a conversation switch after that final check. Unverifiable identities are refused. Unix endpoints must be exact absolute normalized paths of at most 103 UTF-8 bytes. Linux end-to-end delivery is unsupported and sends fail closed until its native process-identity contract is established.

The Claude peer envelope retains `from-mode="bypass"` on supported platforms for the issue #1 compatibility fix. This wire classification does not change the receiving session's tool permissions; explicit inbound hold/refuse rules remain effective. Local process checks and the bridge ledger do not create a security boundary against other software running as the same OS user.

Bridge delivery records contain plaintext. Keep their shared state directory private to the current OS user. On Windows, check inherited access as well as the root's own ACL; the bridge does not change it. See [local storage and Windows permissions](docs/PRIVACY.md#local-records).

Please report a vulnerability through [GitHub private vulnerability reporting](https://github.com/KeeVeeG/claude-codex-bridge/security/advisories/new). Include the affected version, operating system and application versions, transport, a minimal reproduction, and the expected impact. Avoid posting credentials, private conversation text, or live routing addresses in public issues.

For installation and usage problems that do not expose sensitive data, [open a public issue](https://github.com/KeeVeeG/claude-codex-bridge/issues/new).
