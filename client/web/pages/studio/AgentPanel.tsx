"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import ResizeHandle from "@/components/ResizeHandle";
import TerminalsWorkspace from "@/components/TerminalsWorkspace";
import * as api from "@/lib/api";
import { refreshMining, useMining } from "@/lib/mining";
import { terminalsPath } from "@/lib/routes";
import { loadStudioLayout, saveStudioLayout } from "@/lib/studioLayout";
import { useStudio } from "./StudioContext";

/**
 * The studio's terminals side panel — the Terminals workspace embedded
 * chrome-less (one implementation, two hosts). The nav's Terminals link
 * toggles this panel instead of leaving the skill; the header's expand button
 * goes to the full /terminals page, carrying the selected session. When the
 * skill came out of the last mining run (a staged proposal, or an existing
 * skill the run edited), the panel opens on the very conversation that
 * proposed it, revived through the terminal API's resume path if its pane was
 * closed. Otherwise the New-terminal flow starts agents in the skill's
 * folder. Closing the panel detaches; sessions live on (tmux-backed).
 */
export default function AgentPanel({ onClose }: { onClose: () => void }) {
  const { data } = useStudio();
  const mining = useMining();
  const navigate = useNavigate();
  const [focusId, setFocusId] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  // Resizable width (drag the left edge), remembered across skills. The terminal
  // refits itself on resize via its own ResizeObserver.
  const panelRef = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(() => loadStudioLayout().agentW ?? 480);
  const dragTo = useCallback((clientX: number) => {
    const right = panelRef.current?.getBoundingClientRect().right;
    if (right == null) return;
    const max = Math.max(320, window.innerWidth - 480); // leave the editor usable
    const w = Math.round(Math.max(320, Math.min(max, right - clientX)));
    setWidth(w);
    saveStudioLayout({ agentW: w });
  }, []);

  const miningRelated =
    mining?.terminalId != null &&
    (data.root.includes("/generated-skills/") || (mining.improved ?? []).includes(data.root));

  // A mined skill's panel opens on the conversation that proposed it; the
  // server returns its live terminal or revives the recorded session.
  useEffect(() => {
    if (!miningRelated) return;
    let stale = false;
    api
      .mineContinue()
      .then(({ terminalId }) => {
        if (stale) return;
        setFocusId(terminalId);
        void refreshMining(); // the record may now point at a new terminal
      })
      .catch(() => {
        /* the panel still works as a plain terminals view */
      });
    return () => {
      stale = true;
    };
  }, [miningRelated]);

  return (
    <aside ref={panelRef} style={{ width }} className="flex max-w-[70vw] shrink-0 bg-surface">
      <ResizeHandle axis="col" onDragTo={dragTo} />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
          <span className="text-xs font-semibold text-fg">Terminals</span>
          <span className="truncate text-[0.7rem] text-faint">
            {miningRelated ? "the session that mined this" : data.dirName}
          </span>
          <button
            type="button"
            onClick={() => navigate(terminalsPath(activeId ?? undefined))}
            aria-label="Open in full page"
            title="Open in the full Terminals page"
            className="ml-auto rounded p-1 text-faint hover:text-fg"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M15 3h6v6" />
              <path d="M9 21H3v-6" />
              <path d="m21 3-7 7" />
              <path d="m3 21 7-7" />
            </svg>
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close terminals panel"
            className="rounded p-1 text-faint hover:text-fg"
          >
            ✕
          </button>
        </div>
        <div className="min-h-0 flex-1">
          <TerminalsWorkspace
            visible
            embedded
            focusId={focusId}
            defaultCwd={data.root}
            onActiveChange={setActiveId}
          />
        </div>
      </div>
    </aside>
  );
}
