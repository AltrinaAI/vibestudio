"use client";

import type { ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { TerminalMark } from "./FileIcon";
import { ThemeToggle } from "./ui";
import RemoteMenu from "./RemoteMenu";
import { secretsPath } from "@/lib/routes";
import { toggleTheme } from "@/lib/theme";

function TerminalIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="m7 9 3 3-3 3M13 15h4" />
    </svg>
  );
}
function KeyIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="7.5" cy="15.5" r="5.5" />
      <path d="m21 2-9.6 9.6" />
      <path d="m15.5 7.5 3 3L22 7l-3-3" />
    </svg>
  );
}

/** A persistent app-nav link (Terminals, Secrets) shown on every page; the entry
 *  for the current page reads as active. */
function NavLink({ icon, label, active, onClick }: { icon: ReactNode; label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-current={active ? "page" : undefined}
      className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors ${
        active ? "bg-panel text-fg" : "text-muted hover:bg-panel hover:text-fg"
      }`}
    >
      {icon}
      <span className="hidden text-xs sm:inline">{label}</span>
    </button>
  );
}

/**
 * The single top chrome shared by every page, so the bar keeps a constant height
 * and identical layout across the app (no shift when navigating). Left: the "Skill
 * Studio" brand — links home, except on home — plus an optional `breadcrumb` (the
 * page or skill name). Right: the page's own `children` actions, then the
 * persistent app nav (Terminals, Secrets) and the theme toggle, present on every
 * page with the current page marked active. Self-routes via the router, so callers
 * pass only their breadcrumb and contextual actions.
 */
export default function NavBar({ breadcrumb, children }: { breadcrumb?: ReactNode; children?: ReactNode }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const atHome = pathname === "/";

  const brand = (
    <span className="flex items-center gap-1.5">
      <TerminalMark className="h-4.5 w-auto text-fg" />
      <span className="font-medium text-fg">Skill Studio</span>
    </span>
  );

  return (
    <header className="z-20 flex h-12 shrink-0 items-center gap-2 border-b border-border px-3 text-sm">
      {atHome ? (
        <span className="px-1.5">{brand}</span>
      ) : (
        <button
          type="button"
          onClick={() => navigate("/")}
          title="Back to home"
          className="flex items-center rounded-md px-1.5 py-1 hover:bg-panel"
        >
          {brand}
        </button>
      )}
      {breadcrumb}
      <div className="ml-auto flex items-center gap-1">
        {children}
        {children && <span className="mx-1 h-5 w-px bg-border" aria-hidden />}
        <RemoteMenu />
        <NavLink icon={<TerminalIcon />} label="Terminals" active={pathname === "/terminals"} onClick={() => navigate("/terminals")} />
        <NavLink icon={<KeyIcon />} label="Secrets" active={pathname === "/secrets"} onClick={() => navigate(secretsPath())} />
        <ThemeToggle onClick={toggleTheme} />
      </div>
    </header>
  );
}
