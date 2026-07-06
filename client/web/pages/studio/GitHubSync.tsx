"use client";

// "Publish to GitHub" — the Manage panel section that connects a skill to its
// OWN repository and keeps the two in sync. The skill's local git history is
// pushed/pulled directly, so teamwork is ordinary git collaboration. GitHub
// gets one-click repo creation (+ sign-in reuse); ANY other git remote —
// GitLab, Bitbucket, self-hosted — connects by pasting its clone URL, using
// the machine's own git credentials. The remote is the source of truth:
// syncing pulls first, local versions rebase on top, and conflicting hunks
// resolve toward the remote (nothing local is lost — versions stay in history).
//
// Auth is detected server-side from what's already on the machine (a token
// connected here, GH_TOKEN/GITHUB_TOKEN, the gh CLI login, git's credential
// helpers); this UI just shows what was found. When nothing is found it offers
// the OAuth device flow (if the build has a client id) and paste-a-token.
import { useCallback, useEffect, useRef, useState } from "react";
import { Modal } from "@/components/Modal";
import { Spinner, btnPrimary, btnGhost } from "@/components/ui";
import { useConfirm } from "@/components/useConfirm";
import * as api from "@/lib/api";
import type { GhOwner, GhStatus, GhDeviceStart } from "@/lib/api";
import { runGithubSync } from "@/lib/githubSync";
import { useStudio } from "./StudioContext";

const SOURCE_LABEL: Record<string, string> = {
  studio: "connected token",
  env: "environment token",
  "gh-cli": "GitHub CLI",
  "git-credential": "git credentials",
};

const inputCls =
  "w-full rounded-md border border-border bg-panel px-2 py-1.5 text-sm text-fg outline-none focus:border-accent";

// ---- device-flow sign-in modal ----------------------------------------------
function DeviceFlowModal({ onDone, onClose }: { onDone: () => void; onClose: () => void }) {
  const [start, setStart] = useState<GhDeviceStart | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const stopped = useRef(false);

  useEffect(() => {
    stopped.current = false;
    let timer: ReturnType<typeof setTimeout>;
    api
      .githubDeviceStart()
      .then((s) => {
        setStart(s);
        const poll = async () => {
          if (stopped.current) return;
          try {
            const r = await api.githubDevicePoll();
            if (stopped.current) return;
            if (r.status === "ok") return onDone();
            timer = setTimeout(poll, r.interval * 1000);
          } catch (e) {
            if (!stopped.current) setErr(e instanceof Error ? e.message : "Sign-in failed");
          }
        };
        timer = setTimeout(poll, s.interval * 1000);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : "Sign-in failed"));
    return () => {
      stopped.current = true;
      clearTimeout(timer);
    };
  }, [onDone]);

  return (
    <Modal title="Connect GitHub" onClose={onClose}>
      <div className="space-y-3 px-5 py-4">
        {err ? (
          <p className="text-sm text-danger">{err}</p>
        ) : !start ? (
          <p className="flex items-center gap-2 text-sm text-muted">
            <Spinner className="h-3.5 w-3.5" /> Requesting a sign-in code…
          </p>
        ) : (
          <>
            <p className="text-sm text-muted">Enter this code on GitHub to sign in:</p>
            <div className="flex items-center gap-2">
              <span className="rounded-md border border-border bg-panel px-3 py-2 font-mono text-lg font-semibold tracking-[0.2em] text-fg">
                {start.userCode}
              </span>
              <button
                type="button"
                className={btnGhost}
                onClick={() => {
                  void navigator.clipboard?.writeText(start.userCode);
                  setCopied(true);
                }}
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <a
              href={start.verificationUri}
              target="_blank"
              rel="noreferrer noopener"
              className={`${btnPrimary} inline-block`}
            >
              Open github.com/login/device ↗
            </a>
            <p className="flex items-center gap-2 text-xs text-faint">
              <Spinner className="h-3 w-3" /> Waiting for approval…
            </p>
          </>
        )}
      </div>
    </Modal>
  );
}

// ---- connect any git remote by URL (the provider-free path) ------------------
function ConnectByUrl({ root, onConnected }: { root: string; onConnected: (pushed: number) => void }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const doConnect = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.githubConnectRemote(root, url);
      setUrl("");
      setOpen(false);
      onConnected(r.pushed);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't connect");
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button type="button" className="text-xs text-faint hover:text-fg" onClick={() => setOpen(true)}>
        Connect an existing repository instead (GitLab, Bitbucket, any git remote) →
      </button>
    );
  }
  return (
    <div className="space-y-1.5">
      <input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="https://gitlab.com/you/skill.git or git@host:path.git"
        className={`${inputCls} font-mono text-xs`}
        onKeyDown={(e) => e.key === "Enter" && url.trim() && doConnect()}
      />
      <button type="button" onClick={doConnect} disabled={busy || !url.trim()} className={`${btnPrimary} w-full`}>
        {busy ? "Connecting…" : "Connect"}
      </button>
      <p className="text-[0.7rem] text-faint">
        Create an empty repository on any git host and paste its clone URL — pushes/pulls use this machine’s
        own git credentials.
      </p>
      {err && <p className="text-xs text-danger">{err}</p>}
    </div>
  );
}

// ---- the section -------------------------------------------------------------
// Lives in the Source Control sidebar as the "GitHub" panel — the remote half of
// version history (a version action, like the VS Code SCM panel it imitates).
// Handles every state: not signed in, signed in + ready to publish, and
// connected (Sync now / Disconnect). Styled narrow for the sidebar.
export function GitHubSection({ root, dirName }: { root: string; dirName: string }) {
  const { reload, bumpGit, gitVersion } = useStudio();
  const confirm = useConfirm();
  const [status, setStatus] = useState<GhStatus | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [owners, setOwners] = useState<GhOwner[] | null>(null);
  const [owner, setOwner] = useState("");
  const [repo, setRepo] = useState(dirName);
  const [isPrivate, setIsPrivate] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; url?: string } | null>(null);
  const [deviceOpen, setDeviceOpen] = useState(false);
  const [tokenOpen, setTokenOpen] = useState(false);
  const [token, setToken] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [connectErr, setConnectErr] = useState<string | null>(null);

  // Cheap local check first; only pay the network round-trip (fetch + ahead/behind)
  // when there's actually a remote — this panel is always mounted in the sidebar.
  const refresh = useCallback(() => {
    setLoadErr(null);
    api
      .githubStatus(root, false)
      .then((s) => {
        setStatus(s);
        setOwner((o) => o || s.auth?.login || "");
        if (s.link) api.githubStatus(root, true).then(setStatus).catch(() => {});
      })
      .catch((e) => {
        setStatus(null);
        setLoadErr(e instanceof Error ? e.message : "Couldn't reach the server");
      });
  }, [root]);
  useEffect(() => refresh(), [refresh]);
  // Re-check after a version is saved or synced elsewhere (push count, ahead/behind).
  useEffect(() => refresh(), [gitVersion, refresh]);

  // The publish form needs the owner list (account + orgs).
  const formVisible = !!status?.auth && status.tracked && status.hasVersion && !status.link;
  useEffect(() => {
    if (!formVisible || owners) return;
    api
      .githubOwners()
      .then(setOwners)
      .catch(() => {
        // Org listing failed (e.g. token without read:org) — offer the account.
        if (status?.auth) setOwners([{ login: status.auth.login, kind: "user", canCreate: true }]);
      });
  }, [formVisible, owners, status?.auth]);

  const doConnectToken = async () => {
    setConnecting(true);
    setConnectErr(null);
    try {
      await api.githubConnectToken(token);
      setToken("");
      setTokenOpen(false);
      refresh();
    } catch (e) {
      setConnectErr(e instanceof Error ? e.message : "Couldn't connect");
    } finally {
      setConnecting(false);
    }
  };

  const doPublish = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.githubPublish(root, owner, repo, isPrivate);
      setMsg({
        ok: true,
        text: `Published ${r.pushed} version${r.pushed === 1 ? "" : "s"} to ${owner}/${repo}.`,
        url: r.htmlUrl,
      });
      bumpGit(); // publish set origin / pushed — refresh git state
      refresh();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Publish failed" });
    } finally {
      setBusy(false);
    }
  };

  const onUrlConnected = (pushed: number) => {
    setMsg({ ok: true, text: `Connected — pushed ${pushed} version${pushed === 1 ? "" : "s"}.` });
    bumpGit(); // connect set origin / pushed — refresh git state
    refresh();
  };

  const doSync = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await runGithubSync(root, { reload, bumpGit });
      const text =
        r.action === "upToDate"
          ? "Already up to date."
          : r.action === "pushed"
            ? `Pushed ${r.pushed} version${r.pushed === 1 ? "" : "s"}.`
            : r.action === "pulled"
              ? `Pulled ${r.pulled} version${r.pulled === 1 ? "" : "s"}.`
              : `Synced — ${r.pulled} pulled, ${r.pushed} pushed${
                  r.conflictResolved ? "; the remote version won where both changed the same lines" : ""
                }.`;
      setMsg({ ok: true, text });
      refresh();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Sync failed" });
    } finally {
      setBusy(false);
    }
  };

  const doUnlink = async () => {
    if (
      !(await confirm({
        title: "Disconnect from GitHub?",
        body: "The skill keeps its local versions; nothing is removed on GitHub. You can reconnect by publishing again.",
        confirmLabel: "Disconnect",
      }))
    )
      return;
    try {
      await api.githubUnlink(root);
      setMsg(null);
      refresh();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Couldn’t disconnect" });
    }
  };

  if (loadErr) return <p className="text-xs text-danger">{loadErr}</p>;
  if (!status) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted">
        <Spinner className="h-3.5 w-3.5" /> Checking…
      </p>
    );
  }

  // ── not signed in to GitHub (connect-by-URL still works — it needs no sign-in) ──
  if (!status.auth && !status.link) {
    return (
      <div className="space-y-2.5">
        <p className="text-xs text-muted">
          Give this skill its own repository — GitHub, GitLab, or any git remote — and sync versions with
          your team.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {status.deviceFlow && (
            <button type="button" className={btnPrimary} onClick={() => setDeviceOpen(true)}>
              Connect GitHub
            </button>
          )}
          <button type="button" className={btnGhost} onClick={() => setTokenOpen((v) => !v)}>
            Use an access token
          </button>
          <button type="button" onClick={refresh} className="text-xs text-faint hover:text-fg">
            Check again
          </button>
        </div>
        {tokenOpen && (
          <div className="space-y-1.5">
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="ghp_… / github_pat_…"
              className={`${inputCls} font-mono text-xs`}
              onKeyDown={(e) => e.key === "Enter" && token && doConnectToken()}
            />
            <button
              type="button"
              onClick={doConnectToken}
              disabled={connecting || !token.trim()}
              className={`${btnPrimary} w-full`}
            >
              {connecting ? "Checking…" : "Connect"}
            </button>
            <p className="text-[0.7rem] text-faint">
              A classic token with <span className="font-mono">repo</span> scope (add{" "}
              <span className="font-mono">read:org</span> to list your orgs).
            </p>
            {connectErr && <p className="text-xs text-danger">{connectErr}</p>}
          </div>
        )}
        {status.ghCli && (
          <p className="text-[0.7rem] text-faint">
            Tip: sign in once with <span className="font-mono">gh auth login</span> and VibeStudio uses it
            automatically.
          </p>
        )}
        {status.tracked && status.hasVersion && <ConnectByUrl root={root} onConnected={onUrlConnected} />}
        {msg && <p className={`text-xs ${msg.ok ? "text-ok" : "text-danger"}`}>{msg.text}</p>}
        {deviceOpen && (
          <DeviceFlowModal
            onDone={() => {
              setDeviceOpen(false);
              refresh();
            }}
            onClose={() => setDeviceOpen(false)}
          />
        )}
      </div>
    );
  }

  // ── signed in to GitHub, or already connected to any remote ──
  const auth = status.auth;
  const link = status.link;
  const remoteState = (() => {
    if (!link) return null;
    if (status.remoteError) return { text: status.remoteError, tone: "text-warn" };
    if (status.ahead == null || status.behind == null) return { text: "Checking remote…", tone: "text-faint" };
    if (status.ahead === 0 && status.behind === 0) return { text: "Up to date", tone: "text-ok" };
    const parts = [
      status.ahead > 0 ? `${status.ahead} to push` : "",
      status.behind > 0 ? `${status.behind} to pull` : "",
    ].filter(Boolean);
    return { text: parts.join(" · "), tone: "text-warn" };
  })();

  return (
    <div className="space-y-2.5">
      {auth && (
        <p className="text-xs text-muted">
          Publishing as <span className="font-medium text-fg">{auth.login}</span> · via{" "}
          {SOURCE_LABEL[auth.source] ?? auth.source}
          {auth.source === "studio" && (
            <>
              {" · "}
              <button
                type="button"
                className="text-faint underline-offset-2 hover:text-fg hover:underline"
                onClick={() => api.githubDisconnect().then(refresh)}
              >
                forget
              </button>
            </>
          )}
        </p>
      )}

      {!status.tracked ? (
        <p className="text-xs text-muted">
          Turn on versioning for this skill first (Source control → Start versioning), then publish it here.
        </p>
      ) : !status.hasVersion ? (
        <p className="text-xs text-muted">Save a version first — the repository is published with your version history.</p>
      ) : link ? (
        <div className="space-y-2">
          <div className="rounded-md border border-border bg-panel px-3 py-2">
            {link.htmlUrl ? (
              <a
                href={link.htmlUrl}
                target="_blank"
                rel="noreferrer noopener"
                title={link.label}
                className="block truncate font-mono text-xs text-fg underline-offset-2 hover:underline"
              >
                {link.label} ↗
              </a>
            ) : (
              <span className="block truncate font-mono text-xs text-fg" title={link.label}>
                {link.label}
              </span>
            )}
            {remoteState && <p className={`mt-0.5 text-[0.7rem] ${remoteState.tone}`}>{remoteState.text}</p>}
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={doSync}
              disabled={busy}
              title="Pull the remote's versions, then push yours on top"
              className="rounded-md border border-accent/50 px-2.5 py-1 text-xs font-medium text-accent transition-colors hover:bg-accent-soft disabled:opacity-40"
            >
              {busy ? "Syncing…" : "Sync now"}
            </button>
            <button type="button" className="text-xs text-faint hover:text-fg" onClick={doUnlink}>
              Disconnect
            </button>
          </div>
          <p className="text-[0.7rem] text-faint">
            The remote is the source of truth — syncing pulls its changes first; your versions go on top.
          </p>
        </div>
      ) : auth ? (
        <div className="space-y-2">
          <select value={owner} onChange={(e) => setOwner(e.target.value)} className={inputCls}>
            {(owners ?? [{ login: auth.login, kind: "user" as const, canCreate: true }]).map((o) => (
              <option key={o.login} value={o.login} disabled={!o.canCreate}>
                {o.login}
                {o.kind === "org" ? " (org)" : ""}
                {o.canCreate ? "" : " — no permission"}
              </option>
            ))}
          </select>
          <input
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            placeholder={dirName}
            className={`${inputCls} font-mono text-xs`}
          />
          <label className="flex items-center gap-2 text-xs text-muted">
            <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} />
            Private repository
          </label>
          <p className="text-[0.7rem] text-faint">
            Creates <span className="font-mono">{owner || "…"}/{repo || "…"}</span> and pushes this skill’s
            version history.
          </p>
          <button
            type="button"
            onClick={doPublish}
            disabled={busy || !owner || !repo.trim()}
            className={`${btnPrimary} w-full`}
          >
            {busy ? "Publishing…" : "Publish to GitHub"}
          </button>
          <ConnectByUrl root={root} onConnected={onUrlConnected} />
        </div>
      ) : null}

      {status.dirty && status.tracked && (
        <p className="text-[0.7rem] text-faint">Unsaved changes sync once you save them as a version.</p>
      )}
      {msg && (
        <p className={`text-xs ${msg.ok ? "text-ok" : "text-danger"}`}>
          {msg.text}
          {msg.ok && msg.url && (
            <>
              {" · "}
              <a href={msg.url} target="_blank" rel="noreferrer noopener" className="underline underline-offset-2">
                View on GitHub ↗
              </a>
            </>
          )}
        </p>
      )}
    </div>
  );
}
