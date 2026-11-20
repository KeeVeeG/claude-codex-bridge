# Privacy and local data

## Data flow

The bridge lists conversation titles/identifiers so a sender can select a destination, then forwards explicitly submitted text to that supported local Claude Code or Codex conversation. Windows uses native local transports; macOS uses local Unix inboxes for Claude and can use a configured SSH host for Codex. The sender names an exact destination for each message; there is no exclusive pairing. Incoming messages include the verified sender's conversation ID so the recipient can reply. The bridge does not automatically copy entire conversation histories or read project-file contents. A message can itself contain code, paths, personal data, or other information its sender chooses to include.

The plugin communicates with local application endpoints or, when configured on macOS, the selected SSH host. It provides no public HTTP service, analytics endpoint, or hosted message relay. After delivery, Claude or Codex processes the message through the user's existing application/account. Those applications and their providers can process and retain conversation content under their own account settings and policies. Local transport does not mean the receiving AI application operates offline.

For Windows daemon discovery and delivery the bridge launches `codex.exe app-server proxy` (no shell) and talks to Codex's local daemon. With explicit terminal transport, sessions not attached to the daemon are addressed with `codex.exe queue --thread <id> --message <text>` (no shell), so the message text appears on that process's command line while it runs. It reads stored Codex thread metadata, including first-message previews and working directories, to build the chat listing. Codex caller identity comes from the host's per-call metadata; a thread's creation origin does not identify its current client. Daemon and queue delivery submit peer messages as user input, and `bridge_doctor` reports the CLI and daemon versions. Message history is stored locally as before.

The optional macOS SSH route launches `/usr/bin/ssh` with the configured alias, batch authentication, and strict host-key verification. On that host it runs `codex app-server proxy` through the user's login shell and exchanges app-server frames over SSH. Submitted text and destination IDs cross that connection; the bridge can read loaded conversation metadata returned by the host. Message bodies are carried in the SSH stream, not inserted into its command line. Configured SSH discovery and sending stay on that selected host without a local fallback. The host and receiving application may retain submitted messages under their own policies.

## Local records

By default, state is stored under `~/.local/share/claude-codex-bridge` in the user's profile, shared by both applications. The local installer writes that absolute location into the staged MCP configuration; the source configuration contains no personal path. `CLAUDE_CODEX_BRIDGE_STATE_DIR` can explicitly select another shared directory. This avoids app-specific MSIX virtualization of `LOCALAPPDATA` and does not depend on the project working directory. The state volume must support local hard links (for example NTFS or APFS, not FAT or exFAT). Doctor tests this in an existing state directory with empty temporary files; it does not create a missing directory. Records include:

- Outgoing message text, IDs, sender and destination identifiers, timestamps, fingerprints, delivery status, and available transport receipts/errors.
- Manual sends also save their text with the owning task's notice status. Older manual records may have only a fingerprint, from which the text cannot be recovered.
- Conversation names, registry paths, and local routing addresses.
- A Codex host-discovery record with recent local endpoint addresses, context task IDs, and process metadata.

The local installer also saves a configured SSH alias in the staged MCP configuration. The alias identifies an operator-selected host; it is not an SSH credential.

These are ordinary local JSON files, not application-level encrypted storage. The bridge does not implement automatic retention expiry or a message recall operation. Local delivery records remain until the bridge state is removed; messages already delivered to either application remain under that application's controls. Releases before 0.2.0 also stored one-to-one routing metadata; upgrading does not automatically erase those older local records.

The bridge never renames a live ledger. If the previous profile-default directory still exists, follow the [offline migration or explicit pinning instructions](../README.md#updating-from-a-version-before-100). An existing explicit junction or symlink is resolved to its real target; do not retarget it while the bridge is running. Use the real target path when co-running older versions.

Use a private per-user directory, not a shared drive or a folder readable by other accounts. On Windows, Node's file modes do not isolate the JSON files: new files can inherit their parent’s DACL. `bridge_doctor` checks the selected root (or its nearest existing parent) for potentially broad grants; it does not audit every child, calculate effective access for every account, or change permissions. Check the directory and existing delivery files under **Properties > Security > Advanced**.

Earlier versions used `LOCALAPPDATA` and may have records in separate application-specific locations. Changing the default does not automatically migrate or erase those older records.

To remove bridge records, stop its MCP processes and remove the intended bridge state directory after checking its resolved path. This also removes host discovery records. Use the respective application's controls for its conversation copies; deleting bridge state does not delete provider-side records or backups. OS backup or sync software may separately copy a configured state directory.

## Credentials and diagnostics

Claude's delivery credential remains in Claude's own registration/key storage. The bridge reads the selected live session's credential when preparing a send, uses it in process memory, and does not intentionally persist it in bridge state or message text. Models do not receive a routing secret to copy between chats. macOS process verification reads process-start metadata through `ps`; it does not read the process's conversation contents.

SSH credentials, host keys, and authentication agents remain under the user's SSH configuration and the SSH client's control. The bridge does not read or copy private keys, accept new host keys automatically, or weaken strict host-key verification. SSH diagnostics are drained without being copied verbatim into model-visible errors.

The MCP server does not write a diagnostic log of tool arguments. Message text is nevertheless retained in the local delivery records described above and is returned by message/status tools. Applications may retain tool inputs, outputs, errors, and conversation history independently.

`bridge_doctor` checks local transport availability, interface compatibility, caller registration, and the state directory. It does not submit messages, create delivery records, or change permissions. From a verified Codex Desktop task it also registers that task for discovery from Claude. Its results can disclose application availability and local configuration problems; they do not include delivery credentials or message text.

The conversation panel reads local Claude Code history metadata to discover saved session IDs, titles, project folders, and activity times. It reads bridge delivery records to show messages exchanged with the exact owning Codex chat. Native Claude transcript bodies are not returned to the panel or copied to Codex. Manually submitted message text is sent to the selected Claude inbox and included in a context notice in the owning Codex chat. A separate local manual-send ledger tracks notice delivery so retries do not repeat the original message.
The panel also reads the single `desktop.composerEnterBehavior` value from Codex's local `config.toml` when available (`enter`, `cmdIfMultiline`, or `cmdAlways`) so its keyboard behavior matches Codex. It does not return other Codex settings or write the configuration.

## Permissions and scope

The bridge uses ordinary application MCP permissions and checks the sender's runtime identity before accepting a message. A sender selects its destination by conversation ID; knowing an ID does not let it impersonate that conversation. It does not grant file access or bypass application denials. A receiving agent can act on a message using its own permitted tools; the bridge is not a file sandbox or a security boundary against other software running as the same OS user.

The local installer changes plugin/catalog files and keeps the most recent backup of each replaced local catalog and staged plugin directory after a successful install. When it installs Claude, it also adds only the outbound `send_to_codex` MCP tool to the user's allow rules and backs up the previous settings file. That user-level rule applies to all Claude Code sessions using the profile. When it replaces a version before 1.0.0, it also renames the existing bridge rules in `allow`, `ask`, and `deny` to the new tool names, keeping each rule's choice, and removes the old plugin's registrations. If a running Codex holds the old plugin's files, it sets that plugin's `enabled = false` in Codex's `config.toml` instead, keeping a backup of the previous file. `--codex` and `--prepare-only` do not change Claude tool permissions. The installer uses a runtime file allowlist and excludes bridge state, credentials, and backups from release archives.
