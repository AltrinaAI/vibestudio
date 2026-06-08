"use client";

import { useEffect, type ReactNode } from "react";

/**
 * The shared dialog shell every modal in the app is built from: a centered card
 * over a dimmed backdrop, a titled header (with a ✕), Escape-to-close and
 * backdrop-click-to-close. The body and footer are the caller's `children`.
 *
 * Set `dismissDisabled` to block all three close paths (Esc, backdrop, ✕) while
 * an operation is in flight — e.g. mid-save — so it can't be interrupted.
 */
export function Modal({
  title,
  titleLeading,
  titleAside,
  onClose,
  dismissDisabled = false,
  widthClass = "max-w-md",
  children,
}: {
  title: ReactNode;
  /** Rendered before the title (e.g. an icon). */
  titleLeading?: ReactNode;
  /** Rendered after the title, before the ✕ (e.g. a muted filename). */
  titleAside?: ReactNode;
  onClose: () => void;
  dismissDisabled?: boolean;
  /** Tailwind max-width for the card (default `max-w-md`). */
  widthClass?: string;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !dismissDisabled) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, dismissDisabled]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={() => {
        if (!dismissDisabled) onClose();
      }}
    >
      <div
        className={`flex w-full ${widthClass} flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-xl`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border px-5 py-3">
          {titleLeading}
          <span className="text-sm font-semibold text-fg">{title}</span>
          {titleAside}
          <button
            type="button"
            onClick={onClose}
            disabled={dismissDisabled}
            aria-label="Close"
            className="ml-auto rounded-md p-1 text-faint hover:bg-panel hover:text-fg disabled:opacity-40"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
