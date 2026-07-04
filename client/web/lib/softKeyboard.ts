/**
 * Soft-keyboard inset for WebKit (iOS Safari / iOS Chrome), which ignores
 * `interactive-widget=resizes-content`: the keyboard never resizes the layout
 * viewport, so an h-dvh app stays full-height and Safari merely *pans* to the
 * caret once typing starts — the terminal sits buried until the first keystroke.
 *
 * While an editable inside an `.h-dvh` surface is focused and the visual
 * viewport is at least KB_MIN_PX shorter than the layout viewport, stamp
 * `data-kb` + `--app-vvh` on <html>; globals.css then pins `.h-dvh` surfaces to
 * the visual height, the terminal's ResizeObserver refits, and the pty shrinks
 * above the keyboard. On engines that do resize the layout (Chromium via the
 * meta above, desktop), the inset computes to ~0 and this never engages.
 */

/** Below this the shrink is URL-bar churn or rounding, not a keyboard. */
const KB_MIN_PX = 80;

/** Don't clamp below this visual height (landscape phones): the terminal HOST
 *  is the visual height minus ~100px of chrome (NavBar + session row + padding;
 *  embedded panels stack more), and the host must clear TerminalPane's
 *  minimum-size gates (host < 80px / < 5 rows) or the clamp pins a stale or
 *  garbled pty — Safari's native caret pan is the better fallback there. */
const MIN_APP_PX = 280;

function editing(): HTMLElement | null {
  const el = document.activeElement;
  return el instanceof HTMLElement &&
    (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.isContentEditable)
    ? el
    : null;
}

/** The clamp only helps editables the shrink actually moves: inside an .h-dvh
 *  surface and not in a position:fixed overlay (modals size against the
 *  un-shrunk layout viewport — there, and on scrollable min-h-dvh pages,
 *  Safari's own reveal scroll is correct and must not be undone). */
function clampable(el: HTMLElement): boolean {
  const surface = el.closest(".h-dvh");
  if (!surface) return false;
  for (let n: HTMLElement | null = el; n && n !== surface; n = n.parentElement) {
    if (getComputedStyle(n).position === "fixed") return false;
  }
  return true;
}

export function initSoftKeyboard(): void {
  const vv = window.visualViewport;
  if (!vv) return;
  const root = document.documentElement;
  const apply = () => {
    const el = editing();
    // Pinch-zoom (scale !== 1) never engages — a zoomed visual height is not a
    // keyboard — and holds an engaged clamp only while the editable is still
    // focused (releasing under a live keyboard would SIGWINCH-thrash the pty).
    // Blur/keyboard-close must release even mid-zoom: the user may never return
    // to exactly scale 1, and a stranded clamp squishes every .h-dvh page.
    if (vv.scale !== 1) {
      if (!el && "kb" in root.dataset) {
        delete root.dataset.kb;
        root.style.removeProperty("--app-vvh");
      }
      return;
    }
    // Baseline is the ICB (root clientHeight), NOT innerHeight: on mobile the
    // layout viewport grows past the ICB when content overflows, which would
    // read as a phantom keyboard.
    const inset = el ? root.clientHeight - vv.height : 0;
    if (inset >= KB_MIN_PX && vv.height >= MIN_APP_PX && el && clampable(el)) {
      root.dataset.kb = "";
      root.style.setProperty("--app-vvh", `${Math.floor(vv.height)}px`);
      // Undo Safari's caret pan so the shrunken app aligns with the visible area.
      if (window.scrollY > 0 || vv.offsetTop > 0) window.scrollTo(0, 0);
    } else if ("kb" in root.dataset) {
      delete root.dataset.kb;
      root.style.removeProperty("--app-vvh");
    }
  };
  vv.addEventListener("resize", apply);
  vv.addEventListener("scroll", apply);
  window.addEventListener("focusin", apply);
  window.addEventListener("focusout", apply);
}
