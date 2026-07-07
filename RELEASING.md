# Releasing VibeStudio

How a desktop release is cut, verified, and shipped. Read this end-to-end before
your first release; after that the **Checklist** is the working copy.

## How the pipeline works

A release is driven entirely by **pushing a `vX.Y.Z` git tag**:

1. The tag push triggers [`.github/workflows/release.yml`](.github/workflows/release.yml) (workflow name: `build`).
2. It **stamps the version** from the tag (`scripts/stamp-version.sh` rewrites the
   `Cargo.toml` placeholders — the committed value is a `0.0.0` dev placeholder, so
   **there is no version-bump commit**, the tag *is* the version).
3. It builds, per OS:
   - **macOS** — one universal (arm64+x86_64) `.dmg`, Developer ID-signed + Apple-notarized + stapled.
   - **Windows** — NSIS `_x64-setup.exe` (currently **unsigned**).
   - **Linux** — `.deb` only (AppImage is disabled; its bundler is flaky on CI runners).
   - **`skill-server`** standalone binaries for 4 targets (musl x86_64/arm64, macOS x86_64/arm64) — used by Remote-SSH provisioning.
4. `tauri-action` creates a **DRAFT** GitHub Release named `VibeStudio vX.Y.Z`,
   uploads all bundles plus `latest.json` (the updater manifest, with inline minisign signatures).
5. **You publish the draft.** Publishing flips it to "Latest" (which is what the
   auto-updater reads) and triggers [`release-tidy.yml`](.github/workflows/release-tidy.yml),
   which renames installers to stable, version-less names
   (`VibeStudio-macOS.dmg`, `VibeStudio-Windows-x64-setup.exe`,
   `VibeStudio-Linux-x86_64.deb`), drops redundant `.sig` files, and rewrites
   `latest.json` to point at the renamed installers.

Until you publish, **nothing reaches users** — a draft is invisible to the updater.

## The process

> Per release, the human may say where to **pause** (e.g. "stop after CI, I'll
> publish") or to run the whole thing. **Default: pause for confirmation before
> publishing** (step 8) — everything up to and including the draft is reversible;
> publishing is the outward-facing step.

0. **Pick the version.** Next semver after the last tag. Reusing the number of an
   *unpublished* draft is fine — no user ever received it (see "Overwrite a draft").
1. **Local test.** From the repo root:
   ```bash
   npm run build          # tsc --noEmit && vite build
   npm run lint           # eslint
   cargo test --workspace
   ```
   Also review the full diff since the last **published** release
   (`git diff vPREV..HEAD`) for potential bugs before proceeding.
2. **Visual check — the 3 key pages.** Render and *look* (tsc won't catch layout
   bugs). Screenshot **Home**, **Studio**, **Terminals** and confirm no console
   errors. See "Screenshot harness" below. **Gotcha: the SPA is a hash router** —
   `goto("…/studio/<root>")` lands on Home; you must use `…/#/skills/<root>`.
3. **Confirm the tag will be on-branch.** The tagged commit **must be an ancestor
   of `master` and pushed** (`git rev-list --left-right --count origin/master...HEAD`
   → `0  0`). An **off-branch tag makes the Actions token read-only** → the release
   step 403s and the draft never appears. This is the #1 release failure.
4. **Tag and push.**
   ```bash
   git tag -a vX.Y.Z -m "VibeStudio vX.Y.Z" <commit>   # usually HEAD
   git push origin vX.Y.Z
   ```
5. **Watch CI to completion.**
   ```bash
   RUN=$(gh run list --limit 10 --json databaseId,headBranch,name \
     -q '.[] | select(.headBranch=="vX.Y.Z" and .name=="build") | .databaseId' | head -1)
   gh run watch "$RUN" --exit-status --interval 30
   ```
   **macOS notarization is usually the long pole** (~5–20 min; Apple's notary service
   occasionally hangs on a transient — re-run that leg if it stalls far past 20 min).
   After desktop bundles finish, the `skill-server` matrix uploads standalone binaries.
6. **Fix any errors.** If a leg fails: fix on `master`, push, then **delete and
   re-create the tag at the new HEAD** and re-push (`gh release delete vX.Y.Z --yes
   --cleanup-tag` if a draft was made; then re-tag). Re-running a leg is fine for
   transient infra/notary failures.
7. **Write the release message onto the draft.** Succinct, in the house style: a
   one-line **bold headline**, then a few bullets each led by a **bold** phrase.
   Cover everything since the last *published* release (not the last tag —
   skipped/overwritten drafts mean users may be jumping several commits).
   `gh release list` shows which is "Latest" vs "Draft". Put it on the draft
   right away — drafts are invisible, and it's proofreadable in the UI:
   ```bash
   gh release edit vX.Y.Z --notes-file notes.md
   ```
8. **Publish** (after confirmation, per the pause note):
   ```bash
   gh release edit vX.Y.Z --draft=false --latest
   ```
9. **Verify the published release.** Publishing fires `release-tidy`; give it ~30s,
   then confirm the final asset set:
   ```bash
   gh run watch "$(gh run list -w release-tidy --limit 1 --json databaseId -q '.[0].databaseId')" --exit-status
   gh release view vX.Y.Z --json isDraft,assets -q '.isDraft, [.assets[].name]'
   ```
   Expect: the 3 renamed installers + `macos` `.app.tar.gz` + `latest.json` + the 4
   `skill-server-*` binaries (+ `.sha256`).

## Screenshot harness (headless, never touches the live app)

The desktop's own server runs on `:8765` and **must not be killed** (it may host
the agent session driving the release). Verify against a throwaway server instead:

```bash
# fresh server on a spare port, no auth token:
cargo build -p skill-server   # workspace target is ./target, NOT ./server/target
env -u VIBESTUDIO_SERVER_TOKEN ./target/debug/skill-server --port 8799 &
# vite pointed at it (its /api proxy target is overridable):
VITE_API_TARGET=http://127.0.0.1:8799 npx vite --port 1421 --strictPort &
```

Then drive `http://localhost:1421` with `playwright-core` if installed, or any
headless Chromium/CDP harness against cached Chromium
(`~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome`). Studio needs a real
skill root from `GET /api/skills/discover`, reached via `/#/skills/<encoded-root>`.

## Key facts & gotchas

- **No version-bump commit** — the tag is the source of truth; `stamp-version.sh`
  injects it in CI. Manifests stay `0.0.0`.
- **On-branch tags only** (step 3) — off-branch ⇒ read-only token ⇒ 403, no draft.
- **Drafts are invisible to the updater** — only the published "Latest" release feeds auto-update.
- **Overwrite an unpublished draft version:** `gh release delete vX.Y.Z --yes
  --cleanup-tag`, then re-tag at the new commit and re-push. Safe because no user got the draft.
- **Hash router** — screenshots/deep links need `/#/…`.
- **Updater pubkey guard** — CI fails fast if `tauri.conf.json` still carries the
  placeholder pubkey; the real key must be committed. The private key
  (`~/.tauri/vibestudio.key`) is the only readable copy — do not lose it.
- **macOS** signing/notarization secrets and the **updater signing key** live in
  repo Actions secrets (see `release.yml` env). Windows Authenticode is wired but
  currently off (no cert).
