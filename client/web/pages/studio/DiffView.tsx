"use client";

import { useMemo, useState } from "react";
import parseDiff, { type File as DiffFile, type Change } from "parse-diff";

/** Add/modify/delete/rename, derived from a parsed diff file. */
function classify(f: DiffFile): { kind: "added" | "deleted" | "renamed" | "modified"; path: string } {
  const from = f.from && f.from !== "/dev/null" ? f.from : undefined;
  const to = f.to && f.to !== "/dev/null" ? f.to : undefined;
  if (f.new || !from) return { kind: "added", path: to ?? from ?? "?" };
  if (f.deleted || !to) return { kind: "deleted", path: from ?? "?" };
  if (from !== to) return { kind: "renamed", path: `${from} → ${to}` };
  return { kind: "modified", path: to };
}

const STATUS: Record<string, { letter: string; cls: string; title: string }> = {
  added: { letter: "A", cls: "text-ok", title: "Added" },
  deleted: { letter: "D", cls: "text-danger", title: "Deleted" },
  renamed: { letter: "R", cls: "text-info", title: "Renamed" },
  modified: { letter: "M", cls: "text-warn", title: "Modified" },
};

/** Old/new line numbers for a change row (blank on the side it doesn't touch). */
function lineNums(ch: Change): [number | "", number | ""] {
  if (ch.type === "normal") return [ch.ln1, ch.ln2];
  if (ch.type === "add") return ["", ch.ln];
  return [ch.ln, ""];
}

function FileDiff({ file }: { file: DiffFile }) {
  const [open, setOpen] = useState(true);
  const { kind, path } = classify(file);
  const s = STATUS[kind];
  const empty = file.chunks.length === 0;

  return (
    <section className="overflow-hidden rounded-lg border border-border">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`${s.title}: ${path}`}
        className="flex w-full items-center gap-2 bg-panel px-3 py-2 text-left hover:bg-[color-mix(in_srgb,var(--accent)_6%,var(--panel))]"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`shrink-0 text-faint transition-transform ${open ? "rotate-90" : ""}`}
          aria-hidden
        >
          <path d="M9 6l6 6-6 6" />
        </svg>
        <span className={`shrink-0 font-mono text-xs font-bold ${s.cls}`} title={s.title}>
          {s.letter}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg" title={path}>
          {path}
        </span>
        {file.additions > 0 && <span className="shrink-0 font-mono text-xs text-ok">+{file.additions}</span>}
        {file.deletions > 0 && <span className="shrink-0 font-mono text-xs text-danger">−{file.deletions}</span>}
      </button>

      {open &&
        (empty ? (
          <p className="px-3 py-2 text-xs text-muted">
            {kind === "renamed" ? "Renamed with no content changes." : "No textual changes (binary or mode change)."}
          </p>
        ) : (
          <table className="diff">
            <tbody>
              {file.chunks.map((chunk, ci) => (
                <FragmentChunk key={ci} chunk={chunk} />
              ))}
            </tbody>
          </table>
        ))}
    </section>
  );
}

/** A hunk header row followed by its change rows. */
function FragmentChunk({ chunk }: { chunk: DiffFile["chunks"][number] }) {
  return (
    <>
      <tr className="diff-hunk">
        <td colSpan={3}>{chunk.content}</td>
      </tr>
      {chunk.changes.map((ch, i) => {
        const [oldLn, newLn] = lineNums(ch);
        const marker = ch.content.slice(0, 1);
        const text = ch.content.slice(1);
        const rowCls = ch.type === "add" ? "diff-add" : ch.type === "del" ? "diff-del" : "";
        return (
          <tr key={i} className={rowCls}>
            <td className="diff-gutter">{oldLn}</td>
            <td className="diff-gutter">{newLn}</td>
            <td className="diff-code">
              <span className="diff-marker">{marker === " " ? "" : marker}</span>
              {text}
            </td>
          </tr>
        );
      })}
    </>
  );
}

/**
 * Render unified-diff text (straight from `git diff` / `git show`, via the
 * backend) as collapsible, per-file diffs. Parsing is delegated to parse-diff;
 * the rendering is themed to match the app (CSS classes in globals.css).
 */
export default function DiffView({
  diff,
  truncated,
  emptyLabel = "No changes.",
  only,
}: {
  diff: string;
  truncated?: boolean;
  emptyLabel?: string;
  /** When set, show only the file at this repo-relative path (used for the
   *  per-file read-only diff of non-markdown files). */
  only?: string;
}) {
  const files = useMemo(() => {
    const all = parseDiff(diff);
    if (!only) return all;
    return all.filter((f) => {
      const to = f.to && f.to !== "/dev/null" ? f.to : undefined;
      const from = f.from && f.from !== "/dev/null" ? f.from : undefined;
      return to === only || from === only;
    });
  }, [diff, only]);

  if (files.length === 0) {
    return <p className="px-1 py-6 text-center text-sm text-muted">{emptyLabel}</p>;
  }

  return (
    <div className="space-y-3">
      {files.map((f, i) => (
        <FileDiff key={(f.to ?? f.from ?? "") + i} file={f} />
      ))}
      {truncated && (
        <p className="rounded-md bg-panel px-3 py-2 text-xs text-warn">
          Diff is large and was truncated at 2&nbsp;MB. Open the file directly to see the full contents.
        </p>
      )}
    </div>
  );
}
