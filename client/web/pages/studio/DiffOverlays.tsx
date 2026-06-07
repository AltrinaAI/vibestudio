"use client";

import { useCallback, useEffect, useState } from "react";
import { useDiffGeometry } from "@/lib/diffGeometry";

interface Mark {
  topPct: number; // ruler position (% of scroll height)
  hPct: number;
  contentY: number; // px from the top of the scroll content (to scroll/jump to)
  kind: "add" | "mod" | "del";
}

// green = added, yellow = modified, red = deleted.
const kindClass = (kind: Mark["kind"]) => (kind === "del" ? " is-del" : kind === "mod" ? " is-mod" : "");

/**
 * The change overview ruler — the one piece of diff chrome that stays an overlay,
 * because it sits over the SCROLL PANE's right edge (atop the native scrollbar)
 * and you can't decorate the scrollbar from inside CodeMirror. A green/red/yellow
 * mark per changed chunk; click to jump (VS Code "scrollbar decorations"). The
 * left change bars + per-chunk Revert buttons are now in-editor decorations (see
 * LiveEditor's changeTracker), so they live inside the editor column. Positions
 * come from the editor via the diff-geometry store — it alone can locate
 * off-screen / wrapped / widget-displaced lines.
 */
export default function DiffOverlays({ scrollEl }: { scrollEl: HTMLElement | null }) {
  const geom = useDiffGeometry();
  const [marks, setMarks] = useState<Mark[]>([]);

  const recompute = useCallback(() => {
    if (!scrollEl || !geom || geom.marks.length === 0) {
      setMarks([]);
      return;
    }
    const sRect = scrollEl.getBoundingClientRect();
    const eRect = geom.el.getBoundingClientRect();
    // Editor top within the scroll content (scroll-invariant).
    const top = eRect.top - sRect.top + scrollEl.scrollTop;
    const total = scrollEl.scrollHeight || 1;
    setMarks(
      geom.marks.map((m) => {
        const contentY = top + m.top;
        return {
          topPct: (contentY / total) * 100,
          hPct: Math.max((m.height / total) * 100, 0.5),
          contentY,
          kind: m.kind,
        };
      }),
    );
  }, [scrollEl, geom]);

  // Marks are content-relative (scroll-invariant); recompute only on geometry
  // change, pane resize, and content-height change — never per scroll.
  useEffect(() => {
    recompute();
    if (!scrollEl) return;
    const ro = new ResizeObserver(recompute);
    ro.observe(scrollEl);
    if (scrollEl.firstElementChild) ro.observe(scrollEl.firstElementChild);
    window.addEventListener("resize", recompute);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", recompute);
    };
  }, [scrollEl, recompute]);

  if (marks.length === 0 || !scrollEl) return null;

  return (
    <div className="diff-ruler" aria-hidden>
      {marks.map((m, i) => (
        <button
          key={i}
          type="button"
          tabIndex={-1}
          title="Jump to change"
          onClick={() => scrollEl.scrollTo({ top: m.contentY - scrollEl.clientHeight / 2, behavior: "smooth" })}
          className={`diff-ruler-mark${kindClass(m.kind)}`}
          style={{ top: `${m.topPct.toFixed(3)}%`, height: `max(${m.hPct.toFixed(3)}%, 3px)` }}
        />
      ))}
    </div>
  );
}
