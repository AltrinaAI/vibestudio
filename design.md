# Skill Studio — Architecture & Design Principles

> Read this before adding a feature. The one rule that matters most:
> **every capability must be reachable over HTTP.**

## Core principle: frontend ⇄ backend over HTTP (separable, VS Code-remote model)

The app is two parts that can run on **different machines**:

- **Backend (Rust).** All real work — filesystem, git, skill discovery, secrets,
  app-managed terminals, the on-device LLM — lives in `crates/skill-core`
  (transport-agnostic, **no GUI/Tauri deps**) and is exposed over HTTP by
  `crates/skill-server` at `/api/*`.
- **Frontend (React/TS, `src/`).** Talks to the backend through `src/lib/api.ts`.

The contract between them is **HTTP/JSON** (plus **SSE** for streaming). That contract
is what lets the backend run on one machine (WSL2, a remote dev box, a container) and
the frontend in a browser on another — the VS Code-remote model.

## Transports (current reality)

`src/lib/api.ts` auto-selects a transport at runtime via `isTauri`:

- **Browser** → `fetch('/api/...')` → skill-server. The canonical, remote-capable path.
- **Tauri desktop** → in-process `invoke(...)`. A local-only fast path that avoids
  running a separate server process.

Both call the **same** `skill-core` functions, so there is exactly one implementation of
any capability. The Tauri commands (`src-tauri/src/lib.rs`) and the skill-server routes
(`crates/skill-server/src/main.rs`) are **thin wrappers** over `skill-core`.

> **Design intent: HTTP is the source of truth.** `invoke` is an optimization, not a
> second API. A feature that works only via `invoke` is a **bug** — it breaks the
> browser/remote deployment. If you can't reach it from `skill-server`, it isn't done.

## Rule for adding a feature

1. **Logic** → a function in `skill-core` (keep it Tauri-free so `skill-server` still
   builds).
2. **HTTP route** → a match arm in `skill-server`'s `handle()` under `/api/<name>`.
   **Mandatory** — this is the real API.
3. **Tauri command (optional)** → a `#[tauri::command]` wrapper registered in
   `generate_handler!`, for the desktop fast path.
4. **Frontend** → one function in `src/lib/api.ts` using the
   `isTauri ? invoke(...) : http(...)` pattern.

Extra constraints:
- **Streaming** uses SSE on the server (`request.into_writer()` + chunked `data:` frames —
  see `stream_terminal`) and a Tauri `Channel<T>` on the desktop side (see
  `terminal_attach` / `attachTerminal`). Don't design around a duplex channel only one
  transport has.
- **No CSP-violating calls from the webview.** The desktop CSP is `default-src 'self'`;
  any outbound network (e.g. a cloud LLM fallback) must originate in **Rust**, never the
  browser.

## Reference example: on-device commit messages

- Logic: `skill-core/src/engine.rs` + `commitmsg.rs`.
- HTTP: `POST /api/generate-commit-message`, `GET /api/commit-model-status`.
- Tauri: `generate_commit_message`, `commit_model_status`.
- Frontend: `api.generateCommitMessage()` / `api.commitModelStatus()`.
- Verified end-to-end **through the HTTP path** (skill-server) — so it works in the
  remote/browser deployment, not only the native app.

## Dev workflows

| Goal | Backend | Frontend | Open |
|------|---------|----------|------|
| Native desktop | (in-process) | `npm run tauri dev` | the native window |
| Browser, local backend | `cargo run -p skill-server` (`:8765`) | `npm run dev:vite` (`:1420`) | **`localhost:1420`** — Vite proxies `/api` → 8765 |
| Browser, **remote** backend | skill-server on the remote host | `VITE_API_TARGET=http://<remote>:8765 npm run dev:vite` | `localhost:1420` |
| Production / remote, no Vite | `npm run build` then run skill-server | (served by skill-server) | skill-server's port (UI + API, one origin) |

The Vite `/api` proxy lives in `vite.config.ts` (`server.proxy`, target overridable via
`VITE_API_TARGET`). The native app ignores it (it uses `invoke`).

## Open decision: go strictly HTTP-only?

To erase the browser/native divergence entirely (no `invoke` anywhere), the desktop build
would: spawn a loopback `skill-server` on startup, point the webview at it, and make
`api.ts` always use `http`. The desktop and remote experiences become identical and there
is a single code path.

Cost: manage the embedded server's lifecycle (start/health/reap) and add a localhost
`connect-src` to the CSP. **Not yet done** — flagged here as a deliberate choice. Until
then, the rule above (HTTP parity is mandatory; `invoke` is an optional fast path) keeps
the app fully remote-capable.
