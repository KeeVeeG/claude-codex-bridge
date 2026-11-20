# Releases

## Prepare the source

These steps require a Git source checkout, not an extracted plugin. Edit release identity, version, and presentation in root `plugin.json`, and the portable stdio entry in root `mcp.json`. Run `npm run manifests:sync` once to update `package.json`, the native adapters, and `compatibility/native/`, including after a version change. Commit the generated tree with the source changes: the Git marketplaces install it from `main`, which a release reaches only through the gates below. Keep the release MCP environment empty; check, sync and package reject local overrides. For a private install, set the local configuration at install time instead.

The plugin identity and skill namespace are `bridge-claude-codex`; the npm package and archive identity remain `claude-codex-bridge`. The native deployment stores its portable inputs in `config/plugin-source.json` and `config/mcp-source.json` so portable discovery does not change what Codex loads. It retains Codex's native `env_vars`; Claude uses a plugin-only inline server definition with supported nonsecret environment references, not a project `.mcp.json`. The installer stamps the staged version in all manifests and in the Claude launch arguments so an applied interactive reload sees a configuration change.

Agent Plugins 1.0 cannot express native `env_vars`. The separate portable archive uses `${PLUGIN_ROOT}` and still requires a host that supplies the native application context. It does not replace the default native deployment.

## Validate the candidate

The Git marketplaces install the generated runtime from `main`, so a commit there is already a release. Prepare the release as a candidate commit on `dev`: the version bump, the synchronized generated runtime and the release notes. Pushing `dev` runs CI, which tests and packages on Windows and macOS across Node.js 20, 22, 24 and 26; a candidate with failing CI is not published. Nothing reaches `main` or a tag until every gate below passes on that exact commit.

Run the gates in a fresh, clean checkout of the candidate so the tested tree and the uploaded assets cannot come from different revisions. On Windows PowerShell, for example:

```powershell
$version = 'X.Y.Z' # Replace with the version being released.
$tag = "v$version"
git fetch origin
$candidate = git rev-parse origin/dev
$checkout = "../bridge-release-$version"
git worktree add --detach $checkout $candidate
if ($LASTEXITCODE -ne 0) { throw 'Could not check out the candidate commit' }
Set-Location $checkout
if ((git status --porcelain) -or (git rev-parse HEAD) -ne $candidate) { throw 'Use a clean checkout of the candidate commit' }
if ((node -p "require('./package.json').version") -ne $version) { throw 'Candidate and release version differ' }
npm run manifests:check
if ($LASTEXITCODE -ne 0) { throw 'Manifest check failed' }
npm test # Run under Node.js 26, then again under Node.js 22.
if ($LASTEXITCODE -ne 0) { throw 'Tests failed' }
npm run package
if ($LASTEXITCODE -ne 0) { throw 'Packaging failed' }
claude plugin validate dist/marketplace
if ($LASTEXITCODE -ne 0) { throw 'Claude marketplace validation failed' }
```

Then run the two Windows checks against the released 1.0.6. Export the pinned Git tag `v1.0.6` into an empty disposable directory (`git archive v1.0.6 --output=bridge-106.tar`, then extract that archive there).

- **Released writer:** `node test/released-writer.mjs <export-directory>`. It requires the real-writer test to pass and rejects a skipped test or the wrong version. The ordinary suite without the export does not cover the released writer.
- **Packaged upgrade:** `node test/packaged-upgrade.mjs "dist/claude-codex-bridge-$version.zip" <export-directory>`. In a disposable profile it installs 1.0.6 into both clients with the real `claude.exe` and Codex CLIs, upgrades with the packaged ZIP's installer, and requires both clients to have the bridge turned on. It then starts the server each client resolves (Claude's listed definition, in place from the stage folder or from its cached copy as Claude reports; Codex's cached copy) and requires the packaged version at `initialize` and the packaged panel resource. It does not use or change your own profile.

The packager writes these artifacts under `dist/`:

- `claude-codex-bridge-<version>.zip`: the native compatibility plugin and local installer for Windows or the configured macOS SSH workflow.
- `claude-codex-bridge-marketplace-<version>.zip`: a self-contained marketplace for both applications.
- `claude-codex-bridge-portable-<version>.zip`: the Agent Plugins 1.0 package for hosts that provide the required native application context.
- `marketplace/`: the same marketplace unpacked for inspection.
- `SHA256SUMS`: SHA-256 checksums for all three archives.

The archives include runtime code, documentation, and the MIT license. They exclude Git history, test fixtures, local state, credentials, and installer backups. ZIP entry timestamps are fixed for reproducible builds.

## Publish the validated commit

Only after every gate passes, move `main` to the candidate, then tag it. If `main` cannot fast-forward to the candidate, stop: a merge commit is a commit the gates did not test. An existing tag is never reused: if `$tag` exists locally or on `origin`, stop and inspect it.

```powershell
if ((git tag --list $tag) -or (git ls-remote --tags origin "refs/tags/$tag")) { throw "Tag $tag already exists: inspect it before publishing" }
git push origin "$($candidate):refs/heads/main"
if ($LASTEXITCODE -ne 0) { throw 'main did not fast-forward to the candidate' }
git tag -a $tag $candidate -m $tag
if ($LASTEXITCODE -ne 0) { throw 'Could not create the tag' }
git push origin "refs/tags/$tag"
if ($LASTEXITCODE -ne 0) { throw 'Could not push the tag' }
if (((git ls-remote origin "refs/tags/$tag^{}") -split "`t")[0] -ne $candidate) { throw 'The remote tag does not point to the candidate' }
```

From the same verified checkout, upload the three ZIPs and checksum file from the build the gates checked. Use the reviewed release notes, not an automatically generated account of the commit history.

```powershell
gh release create $tag `
  "dist/claude-codex-bridge-$version.zip" `
  "dist/claude-codex-bridge-marketplace-$version.zip" `
  "dist/claude-codex-bridge-portable-$version.zip" `
  dist/SHA256SUMS `
  --verify-tag --title $tag --notes-file "docs/releases/$tag.md"
```

Do not commit `dist/`. If the tag or release already exists, confirm it points to the intended commit and inspect its assets before replacing anything.

## Local marketplace

```powershell
claude plugin marketplace add ./dist/marketplace
claude plugin install bridge-claude-codex@keeveeg --scope user --json
codex plugin marketplace add ./dist/marketplace
codex plugin add bridge-claude-codex@keeveeg --json
```

The generated catalogs use `./plugins/bridge-claude-codex`. Keep that directory and both catalogs together.

## Git marketplace

See [Installation](../README.md#installation) for the Git marketplace commands. The Git catalog is named `keeveeg`. Both source catalogs select the generated `compatibility/native/` directory; Codex uses a Git subdirectory source. The local installer's separate Claude catalog is named `claude-codex-local`.

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
