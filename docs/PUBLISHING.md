# Releases

## Build

Run these commands from a source checkout:

```powershell
npm run manifests:sync
npm run manifests:check
npm test
npm run package
```

Run `npm test` on Node.js 20 too: it is the oldest supported version, and Windows file-system behaviour differs between Node.js versions.

The packager writes these artifacts under `dist/`:

- `claude-codex-bridge-<version>.zip`: the native compatibility plugin and local installer for Windows or the configured macOS SSH workflow.
- `claude-codex-bridge-marketplace-<version>.zip`: a self-contained marketplace for both applications.
- `claude-codex-bridge-portable-<version>.zip`: the Agent Plugins 1.0 package for hosts that provide the required native application context.
- `marketplace/`: the same marketplace unpacked for inspection.
- `SHA256SUMS`: SHA-256 checksums for all three archives.

The archives include runtime code, documentation, and the MIT license. They exclude Git history, test fixtures, local state, credentials, and installer backups. ZIP entry timestamps are fixed for reproducible builds.

## Validate

```powershell
claude plugin validate .claude-plugin/plugin.json
claude plugin validate dist/marketplace
```

Edit release identity, version, and presentation in root `plugin.json`, and the portable stdio command in root `mcp.json`. Run `npm run manifests:sync` to update `package.json`, the legacy adapters, and the generated `compatibility/native/` tree. Commit that generated tree together with the root changes: the Git marketplaces install it. The packager refuses mismatched versions, modified adapters, unexpected native files, or stale runtime copies.

The plugin identity and skill namespace are `bridge-claude-codex`; the npm package and release archives keep the product identity `claude-codex-bridge`. Manifest synchronization preserves that distinction while aligning versions. Repository URLs, transport client identity, and the default state directory also retain `claude-codex-bridge`.

The installer adds cache-specific build suffixes to all staged manifests and `package.json` together. Canonical sources in the native package live in `config/plugin-source.json` and `config/mcp-source.json`; they are kept outside the root portable discovery paths deliberately.

Agent Plugins 1.0 stdio configuration has no `env_vars` forwarding field. The default native deployment preserves the context required by Codex's current filtered MCP launcher; placing portable manifests in its root would change which server definition Codex loads. The separate portable archive uses `${PLUGIN_ROOT}` and requires a host that supplies the application's native context. It does not replace the default native deployment yet.

## GitHub release

After the validation commands pass, commit the source and generated compatibility tree, push the branch, and create the matching tag and release. The release should attach the native plugin archive, marketplace archive, portable archive, and `SHA256SUMS` produced by the same `npm run package` run:

```powershell
$version = node -p "JSON.parse(require('fs').readFileSync('plugin.json', 'utf8')).version"
$tag = "v$version"
git diff --check
git add -A
git commit -m "Release $version"
git push origin main
git tag -a $tag -m "Release $tag"
git push origin $tag
npm run package
gh release create $tag `
  "dist/claude-codex-bridge-$version.zip" `
  "dist/claude-codex-bridge-marketplace-$version.zip" `
  "dist/claude-codex-bridge-portable-$version.zip" `
  dist/SHA256SUMS `
  --title $tag `
  --generate-notes
```

Do not commit `dist/`; it is ignored and is regenerated for each release. Keep the tag, package version, manifests, and checksums aligned. If a tag or release already exists, inspect it before replacing assets so an older package is not silently published under the same version. Windows and macOS CI also run `npm test` and `npm run package` on Node.js 20, 22, 24, and 26 for pushes and pull requests; the local `npm run package` above is needed to create the files uploaded to the release.

## Local marketplace

```powershell
claude plugin marketplace add ./dist/marketplace
claude plugin install bridge-claude-codex@keeveeg --scope user --json
codex plugin marketplace add ./dist/marketplace
codex plugin add bridge-claude-codex@keeveeg --json
```

The generated catalogs use `./plugins/bridge-claude-codex`. Keep that directory and both catalogs together.

## Git marketplace

```powershell
claude plugin marketplace add https://github.com/KeeVeeG/claude-codex-bridge.git
claude plugin install bridge-claude-codex@keeveeg --scope user --json
codex plugin marketplace add https://github.com/KeeVeeG/claude-codex-bridge.git
codex plugin add bridge-claude-codex@keeveeg --json
```

The Git catalog is named `keeveeg`. Both source catalogs select the generated `compatibility/native/` directory; Codex uses a Git subdirectory source. The local installer's separate Claude catalog is named `claude-codex-local`.

## Directory submission references

Git and local marketplaces are separate from OpenAI's universal public directory. The current bridge depends on local application interfaces, an optional macOS SSH route, and a stdio server. The standard public MCP submission path requires a production HTTPS endpoint, and the plugin guidelines restrict unofficial third-party connectors. A portable ZIP does not remove those architecture and review constraints. Consult OpenAI about local application support before planning public submission.

The current OpenAI submission guide starts with a plugin ZIP, automated metadata/skill checks, MCP connection and review, followed by publication. Some companion pages still describe earlier submission forms; use the submission guide below for the current flow. Keep reviewer credentials in the submission portal, outside release archives.

- [OpenAI plugin submission](https://developers.openai.com/plugins/deploy/submission)
- [OpenAI plugin packaging](https://developers.openai.com/plugins/build/plugins)
- [OpenAI plugin extensions](https://developers.openai.com/plugins/build/extensions)
- [OpenAI plugin UI guidelines](https://developers.openai.com/plugins/concepts/ui-guidelines)
- [MCP Apps overview and lifecycle](https://apps.extensions.modelcontextprotocol.io/api/documents/overview.html)
- [Claude Desktop local MCP servers and extensions](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop)
- [Claude plugin submission](https://claude.com/docs/plugins/submit)
- [Claude marketplace distribution](https://code.claude.com/docs/en/plugin-marketplaces)
