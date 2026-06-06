"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useDiffGeometry } from "@/lib/diffGeometry";

interface Mark {
  topPct: number; // ruler position (% of scroll height)
  hPct: number;
  contentY: number; // px from the top of the scroll content (for the bar/button)
  height: number; // px height of the changed block (for the bar)
  kind: "add" | "mod" | "del";
  pos: number;
}

// green = added, yellow = modified, red = deleted.
const kindClass = (kind: Mark["kind"]) => (kind === "del" ? " is-del" : kind === "mod" ? " is-mod" : "");
const kindLabel: Record<Mark["kind"], string> = { add: "Added", mod: "Modified", del: "Removed" };

/**
 * Diff chrome mounted on the SCROLL PANE, OUTSIDE the centered editor column:
 *  • an overview ruler over the pane's right edge (atop the native scrollbar)
 *    with a green/red mark per changed chunk — click to jump (VS Code "scrollbar
 *    decorations");
 *  • a thin green/red change bar in the LEFT margin per chunk (VS Code "dirty
 *    diff" gutter, but placed beyond the text column so it adds no shift);
 *  • in review mode only, a Revert button beside each left bar.
 * All positions come from the editor via the diff-geometry store (it alone can
 * place off-screen / wrapped / widget-displaced lines). The bars and buttons are
 * portaled into the scroll content so they scroll with the text.
 */
export default function DiffOverlays({
  scrollEl,
  showRevert,
  onToggleReview,
}: {
  scrollEl: HTMLElement | null;
  showRevert: boolean;
  onToggleReview: () => void;
}) {
  const geom = useDiffGeometry();
  const [marks, setMarks] = useState<Mark[]>([]);
  const [editorLeft, setEditorLeft] = useState(0);

  const recompute = useCallback(() => {
    if (!scrollEl || !geom || geom.marks.length === 0) {
      setMarks([]);
      return;
    }
    const sRect = scrollEl.getBoundingClientRect();
    const eRect = geom.el.getBoundingClientRect();
    // Editor top/left within the scroll content (scroll-invariant).
    const top = eRect.top - sRect.top + scrollEl.scrollTop;
    setEditorLeft(eRect.left - sRect.left + scrollEl.scrollLeft);
    const total = scrollEl.scrollHeight || 1;
    setMarks(
      geom.marks.map((m) => {
        const contentY = top + m.top;
        return {
          topPct: (contentY / total) * 100,
          hPct: Math.max((m.height / total) * 100, 0.5),
          contentY,
          height: m.height,
          kind: m.kind,
          pos: m.pos,
        };
      }),
    );
  }, [scrollEl, geom]);

  // Marks are content-relative (scroll-invariant); recompute only on geometry
  // change, pane resize, and content-height change — never per scroll. The bars
  // and buttons scroll with the text on their own (they're in the scroll content).
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

  const barLeft = Math.max(2, editorLeft - 11); // thin change bar just left of the text
  const revertLeft = Math.max(2, editorLeft - 34); // revert button further out

  return (
    <>
      {/* Overview ruler over the right scrollbar (track is click-through). */}
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

      {/* Left margin: change bars (always) + Revert buttons (review only). */}
      {createPortal(
        <>
          {marks.map((m, i) => (
            <button
              key={`bar-${i}`}
              type="button"
              tabIndex={-1}
              title={`${kindLabel[m.kind]} since the last commit — click to ${showRevert ? "exit review" : "review"}`}
              aria-label={`${kindLabel[m.kind]} change`}
              onClick={() => {
                // Toggle: into review (and scroll to the change) the first click,
                // back to normal editing the next.
                if (!showRevert) scrollEl.scrollTo({ top: m.contentY - scrollEl.clientHeight / 2, behavior: "smooth" });
                onToggleReview();
              }}
              className={`diff-change-bar${kindClass(m.kind)}`}
              style={{ top: `${Math.round(m.contentY)}px`, height: `${Math.max(Math.round(m.height), 3)}px`, left: `${barLeft}px` }}
            />
          ))}
          {showRevert &&
            geom?.revert &&
            marks.map((m, i) => (
              <button
                key={`rev-${i}`}
                type="button"
                title="Revert this change to the committed version"
                aria-label="Revert this change"
                onClick={() => geom.revert(m.pos)}
                className="diff-revert-btn"
                style={{ top: `${Math.round(m.contentY)}px`, left: `${revertLeft}px` }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M9 14 4 9l5-5" />
                  <path d="M4 9h11a5 5 0 0 1 0 10h-3" />
                </svg>
              </button>
            ))}
        </>,
        scrollEl,
      )}
    </>
  );
}
