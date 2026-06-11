"use client";

import { useEffect, useMemo, useState } from "react";
import { Modal } from "@/components/Modal";
import { btnGhost, btnPrimary, Spinner } from "@/components/ui";
import { useConfirm } from "@/components/useConfirm";
import * as api from "@/lib/api";
import type { AgentOption, MineSource } from "@/lib/api";
import { refreshMining } from "@/lib/mining";

const WINDOWS = [7, 14, 35, 90];

// Per agent family: effort levels the CLI accepts (claude --effort / codex
// model_reasoning_effort) and model choices ("Custom…" takes any model id).
// Empty selection = the user's own CLI defaults. claude's list omits haiku:
// mining runs use the CLI's auto permission mode, which only Opus/Sonnet 4.6+
// support — a haiku run would die at startup.
const EFFORTS: Record<string, string[]> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["low", "medium", "high", "xhigh"],
};
const MODEL_SUGGESTIONS: Record<string, string[]> = {
  claude: ["fable", "opus", "sonnet"],
  codex: ["gpt-5.5"],
};
const CUSTOM_MODEL = "__custom__";

const selectCls =
  "w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-sm text-fg outline-none focus:border-accent";

/**
 * Launch sheet for a mining run. Doubles as the consent surface — the caption
 * states what happens to the transcripts, and Start is the consent. The
 * centerpiece is the actual prompt the agent will receive, editable in place;
 * every transcript store found on this machine is mined (no source picking),
 * so the only knobs are window, agent, and the agent's model/effort.
 */
export default function MineDialog({ onClose, onStarted }: { onClose: () => void; onStarted: () => void }) {
  const [days, setDays] = useState(35);
  const [sources, setSources] = useState<MineSource[] | null>(null);
  const [agents, setAgents] = useState<AgentOption[] | null>(null);
  const [agent, setAgent] = useState("");
  const [model, setModel] = useState("");
  const [customModel, setCustomModel] = useState("");
  const [effort, setEffort] = useState("");
  const [prompt, setPrompt] = useState("");
  const [promptEdited, setPromptEdited] = useState(false);
  const [reinstalling, setReinstalling] = useState(false);
  const [reinstalled, setReinstalled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const confirm = useConfirm();

  // The agent FAMILY drives which models/efforts make sense; a codex model
  // string is meaningless to claude, so switching family resets both.
  const family = agents?.find((a) => a.id === agent)?.agent ?? "";
  useEffect(() => {
    setModel("");
    setCustomModel("");
    setEffort("");
  }, [family]);

  // Re-count whenever the window changes (the caption is the user's evidence
  // of what a run would read).
  useEffect(() => {
    let stale = false;
    setSources(null);
    api
      .mineSources(days)
      .then((s) => !stale && setSources(s))
      .catch(() => !stale && setSources([]));
    return () => {
      stale = true;
    };
  }, [days]);

  // The mine needs an agent the server's registry can run unattended
  // (headless trigger + resumable session) — capability, not family names.
  useEffect(() => {
    api
      .terminalAgents()
      .then((all) => {
        const usable = all.filter((a) => a.canMine);
        setAgents(usable);
        setAgent((cur) => cur || usable[0]?.id || "");
      })
      .catch(() => setAgents([]));
  }, []);

  // The prompt the run will send, fetched from the server (the one place that
  // composes it) and refreshed when the window changes — unless the user has
  // taken it over by editing, in which case their text wins until Reset.
  useEffect(() => {
    if (promptEdited) return;
    let stale = false;
    api
      .minePrompt({ days })
      .then((r) => !stale && setPrompt(r.prompt))
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [days, promptEdited]);

  const totalSessions = useMemo(() => (sources ?? []).reduce((n, s) => n + s.sessions, 0), [sources]);
  const canStart = !busy && agent !== "" && totalSessions > 0 && prompt.trim() !== "";

  const start = async () => {
    if (!canStart) return;
    setBusy(true);
    setErr(null);
    try {
      await api.mineStart({
        days,
        sources: [],
        agent,
        model: (model === CUSTOM_MODEL ? customModel : model).trim(),
        effort,
        prompt,
      });
      await refreshMining();
      onStarted();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn’t start mining");
      setBusy(false);
    }
  };

  // The run follows the user's installed skill-miner copies; this is the way
  // back to the official version when one has drifted or broken.
  const reinstallMiner = async () => {
    if (
      !(await confirm({
        title: "Reinstall the official skill-miner?",
        body: "Replaces every installed copy of the skill-miner skill with the version bundled with Skill Studio. Versioned copies keep their history — the restore shows up as uncommitted changes you can review or revert.",
        confirmLabel: "Reinstall",
        danger: true,
      }))
    )
      return;
    setReinstalling(true);
    setErr(null);
    try {
      await api.mineReinstallMiner();
      setReinstalled(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Reinstall failed");
    } finally {
      setReinstalling(false);
    }
  };

  return (
    <Modal title="Mine your sessions" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void start();
        }}
        className="space-y-4 px-5 py-4"
      >
        <p className="text-xs leading-relaxed text-muted">
          Skill Studio studies your recent agent sessions for work you keep redoing. The run happens on this
          machine, in a terminal you can watch, using your own agent and keys — no new service sees your
          sessions.
        </p>

        <div className="flex items-start gap-3">
          <div className="flex-1">
            <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-muted">Window</label>
            <select value={days} onChange={(e) => setDays(Number(e.target.value))} className={selectCls}>
              {WINDOWS.map((d) => (
                <option key={d} value={d}>
                  Last {d} days
                </option>
              ))}
            </select>
          </div>
          <div className="flex-1">
            <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-muted">Run with</label>
            {agents === null ? (
              <p className="flex items-center gap-2 text-sm text-muted">
                <Spinner className="h-3.5 w-3.5" /> Detecting…
              </p>
            ) : agents.length === 0 ? (
              <p className="text-sm text-muted">No agent CLI found.</p>
            ) : (
              <select value={agent} onChange={(e) => setAgent(e.target.value)} className={selectCls}>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label} ({a.flavorLabel})
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>

        {family && (
          <div className="flex items-start gap-3">
            <div className="flex-1">
              <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-muted">Model</label>
              <select value={model} onChange={(e) => setModel(e.target.value)} className={selectCls}>
                <option value="">Default</option>
                {(MODEL_SUGGESTIONS[family] ?? []).map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
                <option value={CUSTOM_MODEL}>Custom…</option>
              </select>
              {model === CUSTOM_MODEL && (
                <input
                  value={customModel}
                  onChange={(e) => setCustomModel(e.target.value)}
                  placeholder="model id"
                  spellCheck={false}
                  autoFocus
                  className="mt-1.5 w-full rounded-md border border-border bg-surface px-2.5 py-1.5 font-mono text-sm text-fg outline-none placeholder:font-sans focus:border-accent"
                />
              )}
            </div>
            <div className="flex-1">
              <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-muted">Effort</label>
              <select value={effort} onChange={(e) => setEffort(e.target.value)} className={selectCls}>
                <option value="">Default</option>
                {(EFFORTS[family] ?? []).map((x) => (
                  <option key={x} value={x}>
                    {x}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}

        {/* Evidence line: what a run with this window would read. */}
        <p className="text-xs text-muted" aria-live="polite">
          {sources === null ? (
            <span className="flex items-center gap-2">
              <Spinner className="h-3 w-3" /> Counting sessions…
            </span>
          ) : totalSessions === 0 ? (
            "No sessions found in this window."
          ) : (
            `${totalSessions} session${totalSessions === 1 ? "" : "s"} to mine — ${sources
              .filter((s) => s.sessions > 0)
              .map((s) => `${s.label} ${s.sessions}`)
              .join(" · ")}`
          )}
        </p>

        <div>
          <div className="mb-1 flex items-baseline justify-between">
            <label htmlFor="mine-prompt" className="block text-xs font-medium uppercase tracking-wider text-muted">
              Prompt
            </label>
            {promptEdited && (
              <button
                type="button"
                onClick={() => setPromptEdited(false)}
                className="text-xs text-faint hover:text-fg"
                title="Discard your edits and regenerate from the settings"
              >
                Reset
              </button>
            )}
          </div>
          <textarea
            id="mine-prompt"
            value={prompt}
            onChange={(e) => {
              setPrompt(e.target.value);
              setPromptEdited(true);
            }}
            rows={9}
            spellCheck={false}
            className="w-full resize-y rounded-md border border-border bg-surface px-2.5 py-2 font-mono text-xs leading-relaxed text-fg outline-none focus:border-accent"
          />
          <p className="mt-0.5 text-[0.7rem] text-faint">
            Sent verbatim to the agent, which follows your installed <span className="font-mono">skill-miner</span>{" "}
            skill.{" "}
            {reinstalled ? (
              <span className="text-ok">Official version reinstalled ✓</span>
            ) : (
              <button
                type="button"
                onClick={() => void reinstallMiner()}
                disabled={reinstalling}
                className="underline decoration-dotted underline-offset-2 hover:text-fg disabled:opacity-50"
              >
                {reinstalling ? "Reinstalling…" : "Reinstall official version"}
              </button>
            )}
          </p>
        </div>

        {err && <p className="text-xs text-danger">{err}</p>}

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className={btnGhost}>
            Cancel
          </button>
          <button type="submit" disabled={!canStart} className={btnPrimary}>
            {busy ? "Starting…" : "Start mining"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
