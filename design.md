# Skill Studio — Architecture & Design Principles

> Read this before adding a feature. The one rule that matters most:
> **every capability is reached over HTTP. There is no second transport.**

## Core principle: frontend ⇄ backend over HTTP (separable, VS Code-remote model)

The app is two parts that can run on **different machines**:

- **Backend (Rust), `server/`.** All real work — filesystem, git, skill discovery,
  secrets, app-managed terminals, the on-device LLM — lives in `server/skill-core`
  (transport-agnostic, **no GUI/Tauri deps**); `server/skill-term` handles terminals;
  `server/skill-server` exposes them over HTTP at `/api/*` (+ SSE) and serves the UI.
- **Frontend (React/TS), `client/web/`.** Talks to the backend through
  `client/web/lib/api.ts`. `client/desktop/` is the Tauri shell that hosts the webview.

The contract between them is **HTTP/JSON** (plus **SSE** for streaming). That contract
is what lets the backend run on one machine (WSL2, a remote dev box, a container) and
the frontend on another — the VS Code-remote model.

## One transport: HTTP only (decided)

**There is exactly one data path: HTTP/JSON + SSE.** The frontend never calls Tauri
`invoke` for data; `skill-server` is the whole API.

- **Browser.** Loads the SPA from skill-server and calls `/api/*` on the same origin.
- **Desktop (Tauri).** The native shell is a **thin client**, not a backend: on startup
  it brings up a `skill-server` (a loopback one for local use; a tunneled remote one for
  the VS Code-remote case) and points the webview at `http://127.0.0.1:<port>`. The
  webview then runs the exact same SPA, hitting `/api/*` on that same origin.

So **"local" is just "remote where the host is localhost."** Both run identical code.

> **Why we removed the `invoke` fast path.** A dual `invoke`/HTTP transport meant every
> capability had two call sites and could silently diverge — a feature wired only through
> `invoke` worked in the native app but broke the browser/remote deployment. Collapsing to
> HTTP-only erases that divergence and makes "connect to any server you have SSH access to"
> a configuration change, not a second architecture.

### Same-origin keeps the CSP simple

Because the webview always points at the active server's origin, `/api/*` (fetch **and**
the SSE `EventSource`) is always **same-origin**. The desktop CSP `default-src 'self'`
already covers it — local loopback and a remote SSH tunnel alike (the tunnel's local end
is also `127.0.0.1:<port>`). Any *outbound* network beyond the server (e.g. a cloud LLM
fallback) must still originate in **Rust** on the server side, never the webview.

## Rule for adding a feature

1. **Logic** → a function in `skill-core` (keep it Tauri-free so `skill-server` builds).
2. **HTTP route** → a match arm in `skill-server`'s `handle()` under `/api/<name>`.
   **This is the API.** If you can't reach it from skill-server, it isn't done.
3. **Frontend** → one function in `client/web/lib/api.ts` that calls `http(...)`. No
   `invoke`, no `isTauri` branch.

Extra constraints:
- **Streaming** uses SSE (`request.into_writer()` + chunked `data:` frames — see
  `stream_terminal`), consumed with `EventSource` in `api.ts`. It rides a plain socket and
  an SSH tunnel alike. Don't design around a duplex channel.
- **No native-only capabilities.** Picking files/folders goes through the server, not an OS
  dialog: browse the (possibly remote) filesystem with `/api/list-dir` + the in-app
  `FolderPicker`, import a `.zip` via a file-input upload (`/api/import-zip`), export via a
  `/api/download` link. A native OS dialog can only see the *client* machine, so it breaks
  the remote model — there is no `invoke`-only escape hatch.

## Reference example: on-device commit messages

- Logic: `server/skill-core/src/engine.rs` + `commitmsg.rs`.
- HTTP: `POST /api/generate-commit-message`, `GET /api/commit-model-status`.
- Frontend: `api.generateCommitMessage()` / `api.commitModelStatus()` over `http`.
- Verified end-to-end through the HTTP path (skill-server) — the only path.

## Dev workflows

| Goal | Backend | Frontend | Open |
|------|---------|----------|------|
| Browser, local backend | `cargo run -p skill-server` (`:8765`) | `npm run dev:vite` (`:1420`) | **`localhost:1420`** — Vite proxies `/api` → 8765 |
| Browser/desktop, **remote** backend | skill-server on the remote host | `VITE_API_TARGET=http://<remote>:8765 npm run dev:vite` | `localhost:1420` |
| Native desktop | the shell spawns a loopback `skill-server` | `npm run tauri dev` | the native window |
| Production / remote | `npm run build` then run skill-server | (served by skill-server) | skill-server's port (UI + API, one origin) |

The Vite `/api` proxy lives in `vite.config.ts` (`server.proxy`, target overridable via
`VITE_API_TARGET`). In `tauri dev` the desktop shell spawns its own loopback
`skill-server` on `:8765` (the proxy target), so no separate backend is needed.

The desktop runs the server **in-process** by calling `skill_server::spawn(ServerConfig)`
([client/desktop/src/lib.rs](client/desktop/src/lib.rs)); `ServerConfig` already carries
the `token` (bearer-auth) and `examples_base` seams the remote case will use.

## The connection manager (VS Code "Remote - SSH")

Implemented as a **local proxy switchboard** — the realization of "local is just remote
where the host is localhost." The webview NEVER changes origin; the server it talks to
becomes a switchboard:

- `/api/remote/{list,connect,disconnect,status}` is the **connection manager**, always
  handled locally. The impl is `SshRemoteControl` in
  [server/skill-server/src/sshmgr/](server/skill-server/src/sshmgr/) (a `RemoteControl`
  trait object on `ServerConfig`); it shells out to the system `ssh`.
- While connected, **every other `/api/*` (incl. the `/api/terminal/attach` SSE) is
  reverse-proxied** to the remote `skill-server` over the `ssh -L` tunnel
  ([proxy.rs](server/skill-server/src/proxy.rs)), with the bearer token injected on the
  upstream side. So `client/web` is unchanged by remoting, and **the token never reaches
  the browser** — which dissolves the old `EventSource`-can't-send-`Authorization`
  problem entirely (the proxy adds the header; the browser only ever talks same-origin).
- Non-`/api` GETs always serve the local UI, so the remote binary need not serve it.

The connect flow (VS Code-style): read `~/.ssh/config` → detect remote arch (`uname`) →
ensure a version-pinned static-musl `skill-server` is installed (remote `curl`/`wget`, or
a local-download piped over ssh; checksum-verified) → launch it loopback-bound with a
token delivered via env (off the process table) → ONE `ssh` child is both the tunnel and
the lifeline (its held stdin EOFs the remote on disconnect/crash, so no orphan; a monitor
clears the session if it dies). On reaching "connected" the SPA reloads, so the whole
window rebinds to the remote. Terminals are tmux-backed, so sessions survive reconnects.

**Same code in every server.** The manager lives server-side, so a `skill-server`
exposes it whether it runs **in-process in the desktop** or **standalone** (browser-local
dev, or a dev box) — there's no browser-vs-desktop divergence. Two safety gates keep it
off where it shouldn't broker: a *provisioned remote* (launched `--lifeline-stdin`) and a
*non-loopback* bind both leave `ServerConfig::remote = None`.

Provisioning downloads the matching `skill-server-<target>` from the GitHub release whose
tag matches the app version (CI builds static-musl + macOS binaries — see
[.github/workflows/release.yml](.github/workflows/release.yml)). Override the source with
`SKILL_STUDIO_SERVER_BASE_URL` / `SKILL_STUDIO_SERVER_VERSION`.
