# iPhone "full SSH from the phone" — Mac handoff

Goal: the phone becomes a first-class SSH client (Termius-style) via an in-process **russh**
switchboard — desktop keeps the `ssh` shell-out (the split is deliberate; see
[design.md](design.md)). The **backend is done and proven on Linux**; what's left needs the
Apple toolchain. This note is for the agent picking it up on a Mac.

## Done + verified on Linux (all under the `russh-transport` cargo feature)

- **russh transport** — `server/skill-server/src/sshmgr/russh_tx.rs`. Speaks SSH in-process
  (iOS can't spawn `ssh`). `ring` crypto (not aws-lc) → FFI-free iOS cross-compile.
- **Transport seam** — `sshmgr/conn.rs` (`Remote`/`SessionHandle` traits + `build_remote()`).
  One connect orchestration drives both the ssh shell-out and russh. `session.rs`/`provision.rs`
  are generic over it; the desktop path is byte-identical (all pre-existing tests pass).
- **Full switchboard over russh** — detect → provision → launch → `-L` forward → the remote
  server answers HTTP through the tunnel. Proven by `tests/russh_e2e.rs`.
- **Idle-tunnel survival** — `inactivity_timeout=None` + `keepalive_interval=15s`; an 18s-idle
  SSE stream survives (soak test). This was the top runtime risk.
- **TOFU host-key store** — `russh_tx.rs::tofu_accept`, pins fingerprints to
  `~/.config/vibestudio/russh_known_hosts` (no `~/.ssh/known_hosts` on iOS), fails closed.
- **On-device keygen** — `sshmgr/keygen.rs` (ed25519, portable) + `POST /api/ssh/keygen`
  → `{privateKey, publicKey, fingerprint}`. Round-trip tested + curl-verified.

### Re-run the Linux proofs (on the Mac: System Settings ▸ enable Remote Login, use your own key)

```bash
# transport unit/integration tests against a real sshd (localhost:22 via Remote Login):
RUSSH_IT_HOST=127.0.0.1 RUSSH_IT_PORT=22 RUSSH_IT_USER=$USER RUSSH_IT_KEY=~/.ssh/id_ed25519 \
  cargo test -p skill-server --features russh-transport -- --nocapture
# add RUSSH_IT_SOAK=1 for the ~20s idle-tunnel soak.

# whole-switchboard e2e (place a server at the version dir first — note the mkdir):
cargo build -p skill-server
mkdir -p ~/.vibestudio/server/e2e-test
cp target/debug/skill-server ~/.vibestudio/server/e2e-test/skill-server
RUSSH_E2E=1 RUSSH_IT_HOST=127.0.0.1 RUSSH_IT_PORT=22 RUSSH_IT_USER=$USER RUSSH_IT_KEY=~/.ssh/id_ed25519 \
  cargo test -p skill-server --features russh-transport --test russh_e2e -- --nocapture
```

**How russh gets selected today:** `conn::build_remote(host)` calls `russh_tx::creds_for(host)`,
which returns `Some` (→ use russh) only when `VIBESTUDIO_RUSSH=1` and `VIBESTUDIO_RUSSH_KEY` are
set (the id is parsed `user@host[:port]`); otherwise it falls back to the `ssh` shell-out. On
device this env gate must become "always russh, credentials from the store" — see task 2.

## Left to do on the Mac (implementation + testing — not just testing)

### 1. Build split so the iOS target compiles
`client/desktop/Cargo.toml` (package `vibestudio`, lib `app_lib`) currently deps
`skill-term` (unconditional) and `skill-server` (default features). Change to:
- `skill-term = { ..., optional = true }`; `skill-server = { ..., default-features = false }`.
- add a `local-backend` feature (default on) = `["dep:skill-term", "skill-server/local-backend", "dep:tauri-plugin-updater"]`.
- the mobile build: `--no-default-features` + `--features skill-server/russh-transport`.
- `cfg(desktop)` vs `cfg(mobile)` split of `setup()` in `client/desktop/src/lib.rs` — on mobile
  drop `sweep_stale`, the engine seed/reap, the updater plugin + `ShellUpdater`, and the desktop
  `WebviewWindowBuilder` options. `mobile_entry_point` already exists there.
- then `tauri ios init`; add the ATS/cleartext-loopback exception to the generated `Info.plist`
  (allow `http://127.0.0.1`), build/run with `tauri ios dev` / `tauri ios build`.
- **Regression check:** `npm run dev` (desktop) must still work after the split.
- (Only the Mac can compile the `cfg(mobile)` path, which is why this wasn't done on Linux.)

### 2. SecureStore seam so credentials come from the Keychain, not env
Same client-capability pattern as `NotifyControl`/`EditorControl` (`server/skill-server/src/lib.rs`):
a trait in `skill-server`, impl in `client/desktop`, injected via `ServerConfig` → `ServerCtx`.
- Add `trait SecureStore { get_profile(id)->…; get_private_key(id)->String; put_…; list; }`.
  The **private key lives in the iOS Keychain**; the profile (host/port/user) can be JSON.
- **Threading (the non-obvious part):** `creds_for` is a free fn with no context, reached via
  `SshRemoteControl::connect → session::run_connect → conn::build_remote(host) → creds_for(host)`.
  Give `SshRemoteControl::new` the store (it's constructed in `client/desktop`/`main.rs`), stash
  it, and thread a `&dyn SecureStore` param down `run_connect → build_remote → creds_for`. For
  `cfg(mobile)`, `creds_for` should ALWAYS resolve from the store (drop the `VIBESTUDIO_RUSSH`
  env gate); keep the env path for desktop/dev.
- **Keychain access:** from `client/desktop` Rust (which can use Tauri plugins) — pick a Keychain
  plugin or hand-roll ~30 lines of Swift behind the plugin API. `russh_tx::RusshSession::connect`
  already accepts a key path; add a sibling that takes in-memory OpenSSH text
  (`russh::keys::decode_secret_key`) so the key never touches disk.
- **Pin `/api/ssh/keygen` local** so it's never forwarded to a connected remote: add it beside
  the `/api/update/` and `/api/logs/client` checks in `lib.rs` (~L468–480), which run before the
  proxy dispatch (~L544–562).

### 3. Credential UI (mobile only — no `~/.ssh/config` on iOS)
`client/web/components/RemoteMenu.tsx`: a host/user/port form + a "Generate key" action that
POSTs `/api/ssh/keygen`, saves the private key via the SecureStore route, and shows the public
key to paste into the server's `authorized_keys`. Keep it simple (Termius's flow). Gate it to the
mobile/switchboard context (don't change desktop RemoteMenu, which lists `~/.ssh/config`).

### 4. Lifecycle + device test
- **Code:** wire `RunEvent::Resumed` in `client/desktop/src/lib.rs` to reconnect after iOS
  suspends the app (the tunnel dies after ~30s–3min backgrounded — that's expected; PWA Web Push
  already covers app-closed notifications). `reattach`/keep-alive does the hard half.
- **Test on device:** TestFlight build, connect to a real host, confirm a terminal attaches,
  survives background→resume, and holds under an idle SSE stream. Signing/TestFlight: Apple
  account already set up.

## Terminal touch UI — already built (no work needed)

`IS_MAC` covers iOS, touch→copy-mode scroll, coarse Copy/Paste/Select, soft-keyboard clamp,
responsive drawers. Per Harvey: don't gold-plate it (skip the accessory key row for now).
