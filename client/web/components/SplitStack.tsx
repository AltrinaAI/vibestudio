"use client";

// VS Code-style vertical SplitView for the studio sidebar, modeled on
// vs/base/browser/ui/splitview/splitview.ts: section heights are computed in
// pixels in JS and written as explicit styles — never negotiated by CSS flex.
// CSS flex can't express this (a "pinned" flex item still shrinks
// proportionally when the column overflows, so drag boundaries hop and lag);
// VS Code solves it by owning every pane size, and so do we.
//
// Layout model (solve):
// - A collapsed section is exactly its header.
// - An open section targets its pinned height (set by dragging a sash) or its
//   measured content height — so opening a section shows all of it, no inner
//   scroll until space genuinely runs out.
// - Slack goes to the bottom-most open `fill` section; deficit takes from the
//   fills first (bottom-up), then the rest (bottom-up), each to its minimum.
//
// Sash drags don't re-solve: like VS Code's onSashStart/onSashChange, a drag
// snapshots all sizes, then each move applies the total delta to the snapshot,
// walking the sections above and below the sash nearest-first with per-section
// min/max clamps. Collapsed sections have min == max == header, so deltas
// cascade through them. The dragged section's final size is reported back
// (onPin) for persistence; the dragged layout itself is left untouched.

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ResizeHandle from "./ResizeHandle";

const SASH_PX = 1;

interface SectionSpec {
  order: number;
  open: boolean;
  fill: boolean;
  minBody: number;
  pin: number | null;
  headerPx: number;
  contentPx: number;
}

interface DragSession {
  move: (clientY: number) => void;
  end: (resizeId?: string) => number | null;
}

interface StackApi {
  register: (id: string, spec: SectionSpec) => void;
  unregister: (id: string) => void;
  reportContent: (id: string, px: number) => void;
  registerSash: (key: string) => () => void;
  beginDrag: (afterId: string, clientY: number) => DragSession;
  canDrag: (afterId: string) => boolean;
}

const ApiCtx = createContext<StackApi | null>(null);
const SizesCtx = createContext<Record<string, number>>({});

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** A section's bounds while space is negotiated: a collapsed section is locked
 *  to its header (deltas cascade through it, like VS Code's collapsed panes);
 *  an open one can shrink to its minimum — but never below its current size,
 *  so a section smaller than its minimum is never forced to grow. */
function bounds(s: SectionSpec, size: number) {
  if (!s.open) return { min: s.headerPx, max: s.headerPx };
  return { min: Math.min(s.headerPx + s.minBody, size), max: Number.POSITIVE_INFINITY };
}

export function SplitStack({ className = "", children }: { className?: string; children: React.ReactNode }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const registry = useRef(new Map<string, SectionSpec>());
  const sashes = useRef(new Set<string>());
  const sizesRef = useRef<Record<string, number>>({});
  const dragging = useRef(false);
  const skipNextSolve = useRef(false);
  const [sizes, setSizesState] = useState<Record<string, number>>({});
  const [version, setVersion] = useState(0);
  const [containerH, setContainerH] = useState(0);

  const setSizes = useCallback((next: Record<string, number>) => {
    sizesRef.current = next;
    setSizesState(next);
  }, []);

  const ordered = () => [...registry.current.entries()].sort((a, b) => a[1].order - b[1].order);

  // The solver: turn specs into pixel heights that sum to the container.
  const solve = useCallback(() => {
    const el = containerRef.current;
    if (!el || registry.current.size === 0) return;
    const avail = el.clientHeight - sashes.current.size * SASH_PX;
    const entries = ordered();
    const target = new Map<string, number>(
      entries.map(([id, s]) => [id, Math.round(s.open ? (s.pin ?? s.headerPx + s.contentPx) : s.headerPx)]),
    );
    const diff = avail - [...target.values()].reduce((a, b) => a + b, 0);
    const openFillsBottomUp = entries.filter(([, s]) => s.open && s.fill).reverse();
    if (diff > 0) {
      // Slack: the bottom-most open fill absorbs it (else the bottom-most open section).
      const recv = openFillsBottomUp[0] ?? [...entries].reverse().find(([, s]) => s.open);
      if (recv) target.set(recv[0], target.get(recv[0])! + diff);
    } else if (diff < 0) {
      // Deficit: fills give way first (they scroll), then the rest, bottom-up.
      const givers = [...openFillsBottomUp, ...entries.filter(([, s]) => s.open && !s.fill).reverse()];
      let need = -diff;
      for (const [id, s] of givers) {
        if (need <= 0) break;
        const cur = target.get(id)!;
        const take = Math.min(need, cur - bounds(s, cur).min);
        if (take > 0) {
          target.set(id, cur - take);
          need -= take;
        }
      }
      // Anything still left over means the container is smaller than the
      // headers + minimums; the column clips at the bottom.
    }
    setSizes(Object.fromEntries(target));
  }, [setSizes]);

  useLayoutEffect(() => {
    if (skipNextSolve.current) {
      skipNextSolve.current = false;
      return;
    }
    solve();
  }, [solve, version, containerH]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setContainerH(el.clientHeight));
    ro.observe(el);
    setContainerH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const bump = useCallback(() => setVersion((v) => v + 1), []);

  const api = useMemo<StackApi>(
    () => ({
      register(id, spec) {
        const prev = registry.current.get(id);
        registry.current.set(id, spec);
        const changed =
          !prev ||
          prev.order !== spec.order ||
          prev.open !== spec.open ||
          prev.fill !== spec.fill ||
          prev.minBody !== spec.minBody ||
          prev.pin !== spec.pin ||
          prev.headerPx !== spec.headerPx ||
          Math.abs(prev.contentPx - spec.contentPx) >= 1;
        if (changed && !dragging.current) bump();
      },
      unregister(id) {
        if (registry.current.delete(id) && !dragging.current) bump();
      },
      reportContent(id, px) {
        const s = registry.current.get(id);
        if (!s || Math.abs(s.contentPx - px) < 1) return;
        registry.current.set(id, { ...s, contentPx: px });
        // While a sash is held the sizes are the drag's business; the fresh
        // measurement is picked up by the next solve.
        if (!dragging.current) bump();
      },
      registerSash(key) {
        sashes.current.add(key);
        return () => {
          sashes.current.delete(key);
        };
      },
      beginDrag(afterId, startY) {
        // VS Code's onSashStart: freeze the world, then every move applies the
        // total delta to the frozen sizes (never incrementally to live ones).
        dragging.current = true;
        const snap = ordered().map(([id, s]) => {
          const size = sizesRef.current[id] ?? (s.open ? s.headerPx + s.contentPx : s.headerPx);
          return { id, size, ...bounds(s, size) };
        });
        const k = snap.findIndex((v) => v.id === afterId);
        const up = snap.slice(0, k + 1).reverse(); // nearest-above first
        const down = snap.slice(k + 1); // nearest-below first
        const minDelta = Math.max(
          up.reduce((r, v) => r + (v.min - v.size), 0),
          down.length ? down.reduce((r, v) => r + (v.size - v.max), 0) : Number.NEGATIVE_INFINITY,
        );
        const maxDelta = Math.min(
          down.length ? down.reduce((r, v) => r + (v.size - v.min), 0) : Number.POSITIVE_INFINITY,
          up.reduce((r, v) => r + (v.max - v.size), 0),
        );
        const move = (clientY: number) => {
          const delta = clamp(clientY - startY, minDelta, maxDelta);
          const next = { ...sizesRef.current };
          let d = delta;
          for (const v of up) {
            const size = clamp(v.size + d, v.min, v.max);
            d -= size - v.size;
            next[v.id] = size;
          }
          d = delta;
          for (const v of down) {
            const size = clamp(v.size - d, v.min, v.max);
            d += size - v.size;
            next[v.id] = size;
          }
          setSizes(next);
        };
        const end = (resizeId?: string) => {
          dragging.current = false;
          // The dragged layout already sums to the container; the pin update it
          // triggers shouldn't re-solve and shift boundaries under the pointer.
          skipNextSolve.current = true;
          return resizeId != null ? (sizesRef.current[resizeId] ?? null) : null;
        };
        return { move, end };
      },
      canDrag(afterId) {
        const entries = ordered();
        const k = entries.findIndex(([id]) => id === afterId);
        if (k < 0) return false;
        const room = (slice: [string, SectionSpec][]) =>
          slice.reduce((r, [id, s]) => {
            const size = sizesRef.current[id] ?? s.headerPx;
            return r + (size - bounds(s, size).min);
          }, 0);
        // Movable if either side can give up space (the other side then grows).
        return room(entries.slice(0, k + 1)) > 0 || room(entries.slice(k + 1)) > 0;
      },
    }),
    [bump, setSizes],
  );

  return (
    <ApiCtx.Provider value={api}>
      <SizesCtx.Provider value={sizes}>
        <div ref={containerRef} className={`flex flex-col overflow-hidden ${className}`}>
          {children}
        </div>
      </SizesCtx.Provider>
    </ApiCtx.Provider>
  );
}

/** One stacked section: an always-visible header, a scrollable body (when
 *  open), and an optional non-scrolling footer. Content height is measured
 *  (and observed) so the solver can size open sections to exactly fit. */
export function StackSection({
  id,
  order,
  open,
  fill = false,
  minBody = 48,
  pin = null,
  header,
  footer,
  bodyClassName = "",
  children,
}: {
  id: string;
  order: number;
  open: boolean;
  fill?: boolean;
  minBody?: number;
  pin?: number | null;
  header?: React.ReactNode;
  footer?: React.ReactNode;
  bodyClassName?: string;
  children?: React.ReactNode;
}) {
  const api = useContext(ApiCtx)!;
  const sizes = useContext(SizesCtx);
  const headerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);

  const measureContent = () =>
    (contentRef.current?.offsetHeight ?? 0) + (footerRef.current?.offsetHeight ?? 0);

  useLayoutEffect(() => {
    api.register(id, {
      order,
      open,
      fill,
      minBody,
      pin,
      headerPx: headerRef.current?.offsetHeight ?? 0,
      contentPx: measureContent(),
    });
  });
  useEffect(() => () => api.unregister(id), [api, id]);

  // Re-fit when the content itself changes height (async loads, folders
  // expanding) — the inner wrapper is auto-height, so the observer fires on
  // real content changes, not on the section being resized.
  useEffect(() => {
    if (!open) return;
    const els = [contentRef.current, footerRef.current].filter((el): el is HTMLDivElement => el != null);
    if (els.length === 0) return;
    const ro = new ResizeObserver(() => api.reportContent(id, measureContent()));
    els.forEach((el) => ro.observe(el));
    return () => ro.disconnect();
  }, [api, id, open]);

  const h = sizes[id];
  return (
    <section className="flex flex-none flex-col overflow-hidden" style={h != null ? { height: h } : undefined}>
      <div ref={headerRef} className="shrink-0">
        {header}
      </div>
      {open && (
        <div className="min-h-0 flex-1 overflow-auto">
          <div ref={contentRef} className={bodyClassName}>
            {children}
          </div>
        </div>
      )}
      {open && footer != null && (
        <div ref={footerRef} className="shrink-0">
          {footer}
        </div>
      )}
    </section>
  );
}

/** The sash after section `after`. Dragging moves that boundary VS Code-style;
 *  on release, the final size of section `resize` is reported via onPin for
 *  persistence. Renders as an inert line when nothing around it can move. */
export function StackSash({
  after,
  resize,
  onPin,
}: {
  after: string;
  resize?: string;
  onPin?: (px: number) => void;
}) {
  const api = useContext(ApiCtx)!;
  useContext(SizesCtx); // re-evaluate `active` as sizes change
  const session = useRef<DragSession | null>(null);
  useLayoutEffect(() => api.registerSash(after), [api, after]);
  return (
    <ResizeHandle
      axis="row"
      active={api.canDrag(after)}
      onDragStart={(y) => {
        session.current = api.beginDrag(after, y);
      }}
      onDragTo={(y) => session.current?.move(y)}
      onDragEnd={() => {
        const px = session.current?.end(resize);
        session.current = null;
        if (px != null) onPin?.(px);
      }}
    />
  );
}
