"use client";

import { useEffect, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { EditorView, Decoration, WidgetType } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { StateField, StateEffect, type Extension, type Range, type EditorState } from "@codemirror/state";
import {
  HighlightStyle,
  syntaxHighlighting,
  syntaxTree,
  LanguageDescription,
} from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";

// ---------------------------------------------------------------------------
// Syntax highlighting — solid, comprehensive, GitHub-style palette (CSS vars
// so it follows light/dark automatically). Shared by code files and the fenced
// code blocks inside Markdown.
// ---------------------------------------------------------------------------
const codeHighlight = HighlightStyle.define([
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--sx-comment)", fontStyle: "italic" },
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.definitionKeyword, t.operatorKeyword, t.self], color: "var(--sx-keyword)" },
  { tag: [t.string, t.special(t.string), t.docString, t.character, t.attributeValue], color: "var(--sx-string)" },
  { tag: [t.regexp], color: "var(--sx-string)" },
  { tag: [t.number, t.integer, t.float, t.bool, t.null, t.atom, t.unit], color: "var(--sx-number)" },
  { tag: [t.constant(t.variableName), t.standard(t.variableName)], color: "var(--sx-number)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: "var(--sx-function)" },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.name)], color: "var(--sx-type)" },
  { tag: [t.propertyName, t.attributeName], color: "var(--sx-property)" },
  { tag: [t.tagName], color: "var(--sx-tag)" },
  { tag: [t.meta, t.annotation, t.documentMeta, t.processingInstruction], color: "var(--sx-meta)" },
  { tag: [t.punctuation, t.separator, t.bracket, t.brace, t.paren, t.squareBracket, t.angleBracket], color: "var(--sx-punct)" },
  { tag: [t.operator, t.derefOperator, t.compareOperator, t.arithmeticOperator, t.logicOperator, t.bitwiseOperator], color: "var(--sx-keyword)" },
  { tag: [t.variableName, t.labelName, t.definition(t.variableName)], color: "var(--fg)" },
  { tag: [t.escape, t.special(t.brace)], color: "var(--sx-keyword)" },
  { tag: [t.heading], fontWeight: "700", color: "var(--fg)" },
  { tag: [t.strong], fontWeight: "700" },
  { tag: [t.emphasis], fontStyle: "italic" },
  { tag: t.link, color: "var(--accent)", textDecoration: "underline" },
  { tag: t.url, color: "var(--accent)" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.invalid, color: "var(--error)" },
]);

// ---------------------------------------------------------------------------
// Markdown prose — solid headings/bold, readable-but-secondary markers.
// ---------------------------------------------------------------------------
const markdownHighlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: "1.7em", fontWeight: "700", color: "var(--fg)", lineHeight: "1.3" },
  { tag: t.heading2, fontSize: "1.4em", fontWeight: "700", color: "var(--fg)", lineHeight: "1.3" },
  { tag: t.heading3, fontSize: "1.2em", fontWeight: "700", color: "var(--fg)" },
  { tag: t.heading4, fontSize: "1.05em", fontWeight: "700", color: "var(--fg)" },
  { tag: [t.heading5, t.heading6], fontWeight: "700", color: "var(--fg)" },
  { tag: t.strong, fontWeight: "700", color: "var(--fg)" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.link, color: "var(--accent)", textDecoration: "underline" },
  { tag: t.url, color: "var(--muted)" },
  {
    tag: t.monospace,
    fontFamily: "var(--font-mono)",
    fontSize: "0.9em",
    color: "var(--fg)",
    background: "var(--code-bg)",
    borderRadius: "4px",
    padding: "0.05em 0.3em",
  },
  { tag: t.quote, color: "var(--muted)", fontStyle: "italic" },
  // List item text reads as normal body copy; the bullet/number marker is
  // dimmed separately below (processingInstruction).
  { tag: t.list, color: "var(--fg)" },
  // Markup punctuation (#, **, -, >, link brackets, ---): visible but secondary.
  { tag: t.processingInstruction, color: "var(--mark)" },
  { tag: t.contentSeparator, color: "var(--mark)", fontWeight: "700" },
]);

const baseTheme = EditorView.theme({
  "&": { color: "var(--fg)", backgroundColor: "transparent" },
  ".cm-content": { padding: "0" },
  ".cm-gutters": { display: "none" },
});

// ---------------------------------------------------------------------------
// Live preview: fenced code gets a subtle block background; GFM tables render as
// a real grid when the cursor is outside them, and reveal their (monospace)
// source when you click in to edit — Obsidian Live Preview style.
// ---------------------------------------------------------------------------
const codeLineDeco = Decoration.line({ class: "cm-md-code" });
const fenceOpenDeco = Decoration.line({ class: "cm-md-code cm-md-fence-open" });
const fenceCloseDeco = Decoration.line({ class: "cm-md-code cm-md-fence-close" });
const tableSrcLine = Decoration.line({ class: "cm-md-table" });

// Hide a range entirely (replace with nothing). Used to conceal markup markers.
const hideDeco = Decoration.replace({});
// Marks a rendered link so it shows a pointer cursor (it's clickable).
const linkMarkDeco = Decoration.mark({ class: "cm-md-link" });

// Inline markup markers concealed when the cursor isn't on their line:
//   EmphasisMark **/_  ·  StrikethroughMark ~~  ·  CodeMark ` (inline code only —
//   fenced blocks are handled separately).
const CONCEAL_SIMPLE = new Set(["EmphasisMark", "StrikethroughMark", "CodeMark"]);
// These also swallow trailing whitespace so the rendered text has no leading gap.
const CONCEAL_SPACED = new Set(["HeaderMark", "QuoteMark"]);

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Minimal, safe inline-markdown → HTML for table cells (escaped first, then only
// known tags are introduced, so no raw HTML passes through).
function inlineMd(raw: string): string {
  let s = escHtml(raw);
  s = s.replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, (_m, c) => `<strong>${c}</strong>`);
  s = s.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, (_m, p, c) => `${p}<em>${c}</em>`);
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, t, u) => {
    const url = String(u).trim();
    return /^(https?:|\/|\.|#)/.test(url)
      ? `<a href="${escHtml(url)}" target="_blank" rel="noopener noreferrer">${t}</a>`
      : t;
  });
  return s;
}

function splitRow(line: string): string[] {
  let l = line.trim();
  if (l.startsWith("|")) l = l.slice(1);
  if (l.endsWith("|")) l = l.slice(0, -1);
  return l.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}
function isDelimiterRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c.replace(/\s/g, "")));
}
function alignOf(cell: string): string {
  const c = cell.replace(/\s/g, "");
  const l = c.startsWith(":");
  const r = c.endsWith(":");
  return l && r ? "center" : r ? "right" : l ? "left" : "";
}

// Absolute document range of each cell's trimmed content, for a table-row line
// that starts at `lineStart`. Mirrors splitRow's cell boundaries so a rendered
// cell can be edited in place and written straight back to its source bytes.
function cellRanges(line: string, lineStart: number): { from: number; to: number }[] {
  const ranges: { from: number; to: number }[] = [];
  const n = line.length;
  // Mirror splitRow exactly: trim surrounding whitespace, then strip one leading
  // and one (unescaped) trailing framing pipe before tokenizing — so cell indices
  // line up with the displayed cells even on indented / tab-padded rows.
  let lo = 0;
  let hi = n;
  while (lo < hi && /\s/.test(line[lo])) lo++;
  while (hi > lo && /\s/.test(line[hi - 1])) hi--;
  let k = lo;
  if (k < hi && line[k] === "|") k++;
  let end = hi;
  if (end > k && line[end - 1] === "|" && line[end - 2] !== "\\") end--;
  while (k <= end) {
    let segEnd = k;
    while (segEnd < end && !(line[segEnd] === "|" && line[segEnd - 1] !== "\\")) segEnd++;
    let cs = k;
    let ce = segEnd;
    while (cs < ce && /\s/.test(line[cs])) cs++;
    while (ce > cs && /\s/.test(line[ce - 1])) ce--;
    ranges.push({ from: lineStart + cs, to: lineStart + ce });
    if (segEnd >= end) break;
    k = segEnd + 1;
  }
  return ranges;
}

// Indices of the unescaped `|` separators in a table-row line (framing + interior).
function pipePositions(line: string): number[] {
  const ps: number[] = [];
  for (let i = 0; i < line.length; i++) if (line[i] === "|" && line[i - 1] !== "\\") ps.push(i);
  return ps;
}

class TableWidget extends WidgetType {
  constructor(
    readonly from: number,
    readonly source: string,
  ) {
    super();
  }
  eq(other: WidgetType): boolean {
    return other instanceof TableWidget && other.source === this.source && other.from === this.from;
  }
  ignoreEvent(): boolean {
    return true;
  }
  toDOM(view: EditorView): HTMLElement {
    const from = this.from;
    const source = this.source;
    // Non-blank source rows with their absolute offsets, so each rendered cell
    // knows the exact source range to write back to.
    let off = from;
    const lineInfos: { text: string; start: number }[] = [];
    for (const text of source.split("\n")) {
      if (text.trim()) lineInfos.push({ text, start: off });
      off += text.length + 1;
    }
    const rows = lineInfos.map((li) => splitRow(li.text));
    let header: string[] | null = null;
    let headerInfo: { text: string; start: number } | null = null;
    let aligns: string[] = [];
    let body = rows;
    let bodyInfos = lineInfos;
    if (rows.length >= 2 && isDelimiterRow(rows[1])) {
      header = rows[0];
      headerInfo = lineInfos[0];
      aligns = rows[1].map(alignOf);
      body = rows.slice(2);
      bodyInfos = lineInfos.slice(2);
    }

    // Cells are edited through a floating <input> appended OUTSIDE CodeMirror's
    // content DOM. A nested contentEditable cell leaks keys (Ctrl-A, arrows) to
    // CodeMirror and the browser's editing host; a separate <input> avoids all of
    // that and writes the edited text straight back to that one cell's source
    // range, leaving the rest of the table byte-identical.
    // A <textarea> (not <input>) so a cell whose rendered text wraps onto several
    // lines is editable across the whole cell box rather than a single thin strip.
    const input = document.createElement("textarea");
    input.className = "cm-md-cell-input";
    input.spellcheck = false;
    input.rows = 1;
    input.style.display = "none";
    view.dom.appendChild(input);
    let active: { from: number; to: number; raw: string } | null = null;

    const close = (save: boolean) => {
      const a = active;
      active = null;
      input.style.display = "none";
      window.removeEventListener("scroll", onScroll, true);
      if (!a || !save) return;
      // Keep the table valid: no newlines, and escape any new pipes.
      const next = input.value.replace(/\r?\n/g, " ").replace(/(?<!\\)\|/g, "\\|");
      if (next !== a.raw) view.dispatch({ changes: { from: a.from, to: a.to, insert: next } });
    };
    // A wide table scrolls horizontally on its own; commit and close if anything
    // scrolls so the box never detaches from its cell.
    const onScroll = () => close(true);

    const openCell = (cell: HTMLElement, range: { from: number; to: number }, raw: string, align: string) => {
      if (!cell.isConnected) return;
      if (active) close(true); // flush any in-progress edit before re-targeting
      active = { from: range.from, to: range.to, raw };
      const cr = cell.getBoundingClientRect();
      const vr = view.dom.getBoundingClientRect();
      input.style.display = "block";
      input.style.left = `${cr.left - vr.left}px`;
      input.style.top = `${cr.top - vr.top}px`;
      input.style.width = `${cr.width}px`;
      input.style.textAlign = align || "left";
      input.value = raw;
      // Grow to fit the (possibly wrapped) content, but never shorter than the cell.
      input.style.height = "auto";
      input.style.height = `${Math.max(cr.height, input.scrollHeight)}px`;
      input.focus({ preventScroll: true }); // a focus-scroll would trip onScroll
      input.select();
      window.addEventListener("scroll", onScroll, true);
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        close(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        close(false);
      } else if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) {
        // Commit before ⌘S so the save includes the in-progress cell text.
        e.preventDefault();
        close(true);
      }
    });
    input.addEventListener("blur", () => close(true));

    const ncols = header ? header.length : rows[0]?.length ?? 0;

    const makeCell = (tag: "td" | "th", display: string, range: { from: number; to: number }, align: string) => {
      const el = document.createElement(tag);
      if (align) el.style.textAlign = align;
      el.className = "cm-md-cell";
      el.innerHTML = inlineMd(display);
      const raw = source.slice(range.from - from, range.to - from);
      el.addEventListener("mousedown", (e) => {
        e.preventDefault(); // don't let CodeMirror move its own selection
        openCell(el, range, raw, align);
      });
      return el;
    };

    // --- Structural editing. Ops read the LIVE document (so a pending cell edit
    // is reflected) and are surgical — untouched cells stay byte-identical. ---
    const liveLines = (): { text: string; start: number }[] | null => {
      let node = syntaxTree(view.state).resolveInner(from, 1);
      while (node.parent && node.name !== "Table") node = node.parent;
      if (node.name !== "Table") return null;
      const doc = view.state.doc;
      const a = doc.lineAt(node.from);
      const endPos = Math.min(node.to, doc.length);
      const b = doc.lineAt(endPos > a.from ? endPos - 1 : a.from);
      const out: { text: string; start: number }[] = [];
      for (let n = a.number; n <= b.number; n++) {
        const l = doc.line(n);
        if (l.text.trim()) out.push({ text: l.text, start: l.from });
      }
      return out;
    };
    const runOp = (fn: (lines: { text: string; start: number }[]) => void) => {
      if (active) close(true); // commit any in-progress cell edit first
      const lines = liveLines();
      if (lines && lines.length >= 2) fn(lines);
    };
    const blankRow = `|${"  |".repeat(ncols)}`;
    // beforeBody: 0..nbody (nbody = append after the last row).
    const insertRow = (beforeBody: number) =>
      runOp((lines) => {
        if (beforeBody >= lines.length - 2) {
          const last = lines[lines.length - 1];
          view.dispatch({ changes: { from: last.start + last.text.length, insert: `\n${blankRow}` } });
        } else {
          const ln = lines[2 + beforeBody];
          view.dispatch({ changes: { from: ln.start, insert: `${blankRow}\n` } });
        }
      });
    const deleteRow = (bodyIdx: number) =>
      runOp((lines) => {
        const idx = 2 + bodyIdx;
        if (idx < 2 || idx >= lines.length) return;
        const ln = lines[idx];
        if (idx < lines.length - 1) view.dispatch({ changes: { from: ln.start, to: lines[idx + 1].start } });
        else {
          const prev = lines[idx - 1];
          view.dispatch({ changes: { from: prev.start + prev.text.length, to: ln.start + ln.text.length } });
        }
      });
    // beforeCol: 0..ncols (ncols = append on the right). Inserts a cell into
    // every line right after the boundary pipe — only those bytes change.
    const insertCol = (beforeCol: number) =>
      runOp((lines) => {
        const changes: { from: number; insert: string }[] = [];
        lines.forEach((ln, i) => {
          const pipes = pipePositions(ln.text);
          if (pipes.length < beforeCol + 1) return;
          changes.push({ from: ln.start + pipes[beforeCol] + 1, insert: i === 1 ? " --- |" : "  |" });
        });
        if (changes.length) view.dispatch({ changes });
      });
    const deleteCol = (colIdx: number) =>
      runOp((lines) => {
        if (ncols < 2) return;
        const changes: { from: number; to: number }[] = [];
        for (const ln of lines) {
          const pipes = pipePositions(ln.text);
          if (pipes.length < colIdx + 2) continue;
          changes.push({ from: ln.start + pipes[colIdx], to: ln.start + pipes[colIdx + 1] });
        }
        if (changes.length) view.dispatch({ changes });
      });
    // Small gutter control button (delete handle / insert "+").
    const ctrlBtn = (cls: string, title: string, fn: () => void, html?: string) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = cls;
      b.title = title;
      if (html) b.innerHTML = html;
      b.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        fn();
      });
      return b;
    };

    const table = document.createElement("table");
    table.className = "cm-md-rendered-table";
    if (header && headerInfo) {
      const ranges = cellRanges(headerInfo.text, headerInfo.start);
      const fallback = { from: headerInfo.start, to: headerInfo.start };
      const thead = document.createElement("thead");
      const tr = document.createElement("tr");
      header.forEach((cell, i) => tr.appendChild(makeCell("th", cell, ranges[i] ?? fallback, aligns[i] ?? "")));
      thead.appendChild(tr);
      table.appendChild(thead);
    }
    const tbody = document.createElement("tbody");
    body.forEach((r, ri) => {
      const info = bodyInfos[ri];
      const ranges = info ? cellRanges(info.text, info.start) : [];
      const fallback = { from: info?.start ?? from, to: info?.start ?? from };
      const tr = document.createElement("tr");
      r.forEach((cell, i) => tr.appendChild(makeCell("td", cell, ranges[i] ?? fallback, aligns[i] ?? "")));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    const scroll = document.createElement("div");
    scroll.className = "cm-md-table-scroll";
    scroll.appendChild(table);

    const wrap = document.createElement("div") as HTMLDivElement & {
      _cellInput?: HTMLTextAreaElement;
      _ro?: ResizeObserver;
    };
    wrap.className = header ? "cm-md-table-wrap cm-tg" : "cm-md-table-wrap";
    wrap._cellInput = input;
    wrap.appendChild(scroll);

    // Notion-style controls overlaid from MEASURED geometry: a "+" bubble that
    // pops up at the row/column boundary nearest the pointer, delete handles in
    // the gutters, and a copy button in the corner. Rebuilt on resize.
    if (header && headerInfo) {
      const overlay = document.createElement("div");
      overlay.className = "cm-tg-overlay";
      wrap.appendChild(overlay);

      let geom: { top: number; bottom: number; left: number; right: number; colBounds: number[]; rowBounds: number[] } | null = null;
      let colIdx = -1;
      let rowIdx = -1;
      let colDels: HTMLElement[] = [];
      let rowDels: HTMLElement[] = [];
      const colPlus = ctrlBtn("cm-tg-plus", "Insert column here", () => {
        if (colIdx >= 0) insertCol(colIdx);
      }, "+");
      const rowPlus = ctrlBtn("cm-tg-plus", "Insert row here", () => {
        if (rowIdx >= 0) insertRow(rowIdx);
      }, "+");

      // A small dropdown so deleting a row/column is a deliberate two-step.
      const menu = document.createElement("div");
      menu.className = "cm-tg-menu";
      menu.style.display = "none";
      wrap.appendChild(menu);
      let docDown: ((ev: MouseEvent) => void) | null = null;
      const closeMenu = () => {
        menu.style.display = "none";
        if (docDown) {
          window.removeEventListener("mousedown", docDown);
          docDown = null;
        }
      };
      const openMenu = (e: MouseEvent, label: string, fn: () => void) => {
        const wr = wrap.getBoundingClientRect();
        const item = document.createElement("button");
        item.type = "button";
        item.className = "cm-tg-menu-item";
        item.innerHTML = `${TRASH_ICON}<span>${label}</span>`;
        item.addEventListener("mousedown", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          closeMenu();
          fn();
        });
        menu.replaceChildren(item);
        menu.style.left = `${e.clientX - wr.left}px`;
        menu.style.top = `${e.clientY - wr.top + 6}px`;
        menu.style.display = "block";
        docDown = (ev) => {
          if (!menu.contains(ev.target as Node)) closeMenu();
        };
        setTimeout(() => docDown && window.addEventListener("mousedown", docDown), 0);
      };
      const handle = (cls: string, title: string, label: string, fn: () => void) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = cls;
        b.title = title;
        b.addEventListener("mousedown", (e) => {
          e.preventDefault();
          e.stopPropagation();
          openMenu(e, label, fn);
        });
        return b;
      };

      const build = () => {
        overlay.replaceChildren();
        colDels = [];
        rowDels = [];
        geom = null;
        const headRow = table.querySelector("thead tr");
        if (!headRow) return;
        const headCells = Array.from(headRow.children) as HTMLElement[];
        if (!headCells.length) return;
        const bodyRows = Array.from(table.querySelectorAll("tbody tr")) as HTMLElement[];
        const wr = wrap.getBoundingClientRect();
        const cols = headCells.map((c) => c.getBoundingClientRect());
        const rrows = bodyRows.map((r) => r.getBoundingClientRect());
        const headR = headRow.getBoundingClientRect();
        const top = headR.top - wr.top;
        const left = cols[0].left - wr.left;
        const right = cols[cols.length - 1].right - wr.left;
        const bottom = (rrows.length ? rrows[rrows.length - 1].bottom : headR.bottom) - wr.top;
        geom = {
          top,
          bottom,
          left,
          right,
          colBounds: [...cols.map((c) => c.left - wr.left), right],
          rowBounds: [...rrows.map((r) => r.top - wr.top), bottom],
        };
        cols.forEach((c, i) => {
          const del = handle("cm-tg-coldel", "Column options", "Delete column", () => deleteCol(i));
          del.style.left = `${c.left - wr.left + 1}px`;
          del.style.width = `${c.width - 2}px`;
          del.style.top = `${top - 9}px`;
          overlay.appendChild(del);
          colDels.push(del);
        });
        rrows.forEach((r, i) => {
          const del = handle("cm-tg-rowdel", "Row options", "Delete row", () => deleteRow(i));
          del.style.top = `${r.top - wr.top + 2}px`;
          del.style.height = `${r.height - 4}px`;
          del.style.left = `${left - 9}px`;
          overlay.appendChild(del);
          rowDels.push(del);
        });
        overlay.appendChild(colPlus);
        overlay.appendChild(rowPlus);
      };

      const onMove = (e: MouseEvent) => {
        if (!geom) return;
        const wr = wrap.getBoundingClientRect();
        const x = e.clientX - wr.left;
        const y = e.clientY - wr.top;
        // "+" bubble at the nearest column boundary
        let cb = -1;
        if (y >= geom.top - 16 && y <= geom.bottom + 6) {
          let d = 7;
          geom.colBounds.forEach((bx, i) => {
            const dd = Math.abs(x - bx);
            if (dd < d) { d = dd; cb = i; }
          });
        }
        colIdx = cb;
        if (cb >= 0) {
          colPlus.style.left = `${geom.colBounds[cb] - 8}px`;
          colPlus.style.top = `${geom.top - 9}px`;
        }
        colPlus.classList.toggle("on", cb >= 0);
        // "+" bubble at the nearest row boundary
        let rb = -1;
        if (x >= geom.left - 16 && x <= geom.right + 6) {
          let d = 7;
          geom.rowBounds.forEach((by, i) => {
            const dd = Math.abs(y - by);
            if (dd < d) { d = dd; rb = i; }
          });
        }
        rowIdx = rb;
        if (rb >= 0) {
          rowPlus.style.top = `${geom.rowBounds[rb] - 8}px`;
          rowPlus.style.left = `${geom.left - 9}px`;
        }
        rowPlus.classList.toggle("on", rb >= 0);
        // only the hovered column's / row's delete handle shows (Notion-style)
        let hc = -1;
        if (y >= geom.top - 12 && y <= geom.bottom && x >= geom.left && x <= geom.right) {
          for (let i = 0; i < colDels.length; i++) {
            if (x >= geom.colBounds[i] && x < geom.colBounds[i + 1]) { hc = i; break; }
          }
        }
        colDels.forEach((el, i) => el.classList.toggle("on", i === hc));
        let hr = -1;
        if (x >= geom.left - 12 && x <= geom.right && y >= geom.top) {
          for (let i = 0; i < rowDels.length; i++) {
            if (y >= geom.rowBounds[i] && y < geom.rowBounds[i + 1]) { hr = i; break; }
          }
        }
        rowDels.forEach((el, i) => el.classList.toggle("on", i === hr));
      };
      wrap.addEventListener("mousemove", onMove);
      wrap.addEventListener("mouseleave", () => {
        colIdx = -1;
        rowIdx = -1;
        colPlus.classList.remove("on");
        rowPlus.classList.remove("on");
        colDels.forEach((el) => el.classList.remove("on"));
        rowDels.forEach((el) => el.classList.remove("on"));
      });

      const ro = new ResizeObserver(() => build());
      ro.observe(table);
      wrap._ro = ro;
    }
    return wrap;
  }
  destroy(dom: HTMLElement): void {
    const d = dom as HTMLElement & { _cellInput?: HTMLTextAreaElement; _ro?: ResizeObserver };
    d._cellInput?.remove();
    d._ro?.disconnect();
  }
}

// Clipboard / check icons for the code-block copy button (SVG renders crisply
// across WebViews; an emoji/text would not).
const COPY_ICON =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const CHECK_ICON =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
// Trash icon for the table row/column delete menu.
const TRASH_ICON =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';

// A small copy button pinned to the top-right of a fenced code block.
class CopyButtonWidget extends WidgetType {
  constructor(readonly code: string) {
    super();
  }
  eq(other: WidgetType): boolean {
    return other instanceof CopyButtonWidget && other.code === this.code;
  }
  ignoreEvent(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cm-md-copy";
    btn.innerHTML = COPY_ICON;
    btn.title = "Copy code";
    btn.setAttribute("aria-label", "Copy code");
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      void navigator.clipboard
        ?.writeText(this.code)
        .then(() => {
          btn.innerHTML = CHECK_ICON;
          btn.classList.add("is-copied");
          setTimeout(() => {
            btn.innerHTML = COPY_ICON;
            btn.classList.remove("is-copied");
          }, 1200);
        })
        .catch(() => {});
    });
    return btn;
  }
}

// Track editor focus so tables re-render to a grid once you click away.
const setFocused = StateEffect.define<boolean>();
const focusField = StateField.define<boolean>({
  create: () => false,
  update(val, tr) {
    for (const e of tr.effects) if (e.is(setFocused)) return e.value;
    return val;
  },
});
const focusWatcher = EditorView.domEventHandlers({
  focus: (_e, view) => {
    view.dispatch({ effects: setFocused.of(true) });
  },
  blur: (_e, view) => {
    view.dispatch({ effects: [setFocused.of(false), setEdit.of(null)] });
  },
});

// Reveal markup for editing only on an explicit double-click — a single click
// just places the caret, so reading/navigating never reflows. `editField` holds
// the block opened for editing; it collapses when the caret leaves it or on blur.
type EditRange = { from: number; to: number } | null;
const setEdit = StateEffect.define<EditRange>();
const editField = StateField.define<EditRange>({
  create: () => null,
  update(val, tr) {
    for (const e of tr.effects) if (e.is(setEdit)) return e.value;
    if (!val) return null;
    let { from, to } = val;
    if (tr.docChanged) {
      from = tr.changes.mapPos(from, -1);
      to = tr.changes.mapPos(to, 1);
    }
    if (tr.selection) {
      const head = tr.state.selection.main.head;
      if (head < from || head > to) return null; // caret left the block → collapse
    }
    return { from, to };
  },
});

// The top-level block (paragraph, heading, table, fenced code, …) containing pos.
function blockRangeAt(state: EditorState, pos: number): { from: number; to: number } {
  const tree = syntaxTree(state);
  // Climb to the top-level block, but stop at a list ITEM so double-clicking one
  // bullet reveals just that item rather than the whole list.
  let node = tree.resolveInner(pos, 1);
  for (let n: typeof node | null = node; n; n = n.parent) {
    if (n.name === "ListItem") {
      node = n;
      break;
    }
    if (!n.parent || n.parent.name === "Document") {
      node = n;
      break;
    }
  }
  if (node.name === "Document") {
    // On a blank line between blocks — just the clicked line.
    const line = state.doc.lineAt(pos);
    return { from: line.from, to: line.to };
  }
  const startLine = state.doc.lineAt(node.from);
  const endPos = Math.min(node.to, state.doc.length);
  const endLine = state.doc.lineAt(endPos > startLine.from ? endPos - 1 : startLine.from);
  return { from: startLine.from, to: endLine.to };
}

// Double-click → reveal the block under the pointer for editing. We do NOT touch
// the selection: the browser's native double-click word-selection stands, so you
// can still double-click to select (and copy) text inside code blocks, etc.
const editGate = EditorView.domEventHandlers({
  dblclick: (event, view) => {
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos == null) return false;
    view.dispatch({ effects: setEdit.of(blockRangeAt(view.state, pos)) });
    return false;
  },
});

// ---------------------------------------------------------------------------
// In-page anchor links: a single click on a [text](#heading) link scrolls to
// that heading (GitHub-style slug match). A double-click instead edits the link.
// ---------------------------------------------------------------------------
function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-");
}

function headingPosForSlug(state: EditorState, slug: string): number | null {
  const tree = syntaxTree(state);
  let result: number | null = null;
  tree.iterate({
    enter: (node) => {
      if (result != null) return false;
      if (/^ATXHeading[1-6]$/.test(node.name)) {
        const line = state.doc.lineAt(node.from);
        if (slugify(line.text.replace(/^#+\s*/, "")) === slug) {
          result = node.from;
          return false;
        }
      }
      return undefined;
    },
  });
  return result;
}

// The link under (x, y): an in-page anchor (with its target heading) or an
// external http(s) URL, plus the link's source range. Null if not a link.
type LinkHit =
  | { kind: "anchor"; target: number; from: number; to: number }
  | { kind: "external"; url: string; from: number; to: number };
function anchorAt(view: EditorView, x: number, y: number): LinkHit | null {
  const pos = view.posAtCoords({ x, y });
  if (pos == null) return null;
  let node: ReturnType<typeof syntaxTree>["topNode"] | null = syntaxTree(view.state).resolveInner(pos, 1);
  while (node && node.name !== "Link") node = node.parent;
  if (!node) return null;
  const urlNode = node.getChild("URL");
  if (!urlNode) return null;
  const url = view.state.doc.sliceString(urlNode.from, urlNode.to).trim();
  if (url.startsWith("#")) {
    const target = headingPosForSlug(view.state, slugify(url.slice(1)));
    return target == null ? null : { kind: "anchor", target, from: node.from, to: node.to };
  }
  if (/^https?:\/\//i.test(url)) return { kind: "external", url, from: node.from, to: node.to };
  return null;
}

const anchorNav = (() => {
  let pending: ReturnType<typeof setTimeout> | null = null;
  const cancel = () => {
    if (pending) {
      clearTimeout(pending);
      pending = null;
    }
  };
  return EditorView.domEventHandlers({
    // Only a genuine double-click (edit-the-link) cancels a pending jump — NOT
    // every mousedown, so an impatient re-click never swallows the navigation.
    dblclick: () => {
      cancel();
      return false;
    },
    click: (event, view) => {
      if (event.button !== 0 || event.detail !== 1) return false;
      const hit = anchorAt(view, event.clientX, event.clientY);
      if (!hit) return false;
      const edit = view.state.field(editField, false);
      if (edit && edit.from <= hit.to && edit.to >= hit.from) return false; // editing this link
      cancel();
      pending = setTimeout(() => {
        pending = null;
        if (hit.kind === "anchor")
          view.dispatch({ effects: EditorView.scrollIntoView(hit.target, { y: "start", yMargin: 60 }) });
        else window.open(hit.url, "_blank", "noopener");
      }, 180);
      return false;
    },
  });
})();

function buildMarkdownDecorations(state: EditorState): DecorationSet {
  const doc = state.doc;
  const tree = syntaxTree(state);
  const focused = state.field(focusField, false);
  const edit = state.field(editField, false);
  const decos: Range<Decoration>[] = [];

  // Markup is revealed only inside the block opened by a double-click (editField),
  // and only while focused — a single click just places the caret, so reading
  // never reflows. `editIntersects` covers multi-line blocks (tables, fences).
  const active = focused && edit ? edit : null;
  const editIntersects = (from: number, to: number) =>
    active != null && active.from <= to && active.to >= from;
  const lineActive = (pos: number) => {
    const line = doc.lineAt(pos);
    return editIntersects(line.from, line.to);
  };

  // Hide a marker, plus any whitespace up to the line's content (for # and >).
  const concealSpaced = (from: number, to: number) => {
    const line = doc.lineAt(from);
    let end = to;
    while (end < line.to && doc.sliceString(end, end + 1) === " ") end++;
    decos.push(hideDeco.range(from, end));
  };

  tree.iterate({
    enter: (node) => {
      const name = node.name;

      // Fenced code: subtle card background; the ``` fences become a faint
      // language label (top) and bottom padding — concealed unless you edit it.
      if (name === "FencedCode") {
        const block = node.node;
        const starts: number[] = [];
        let pos = block.from;
        while (true) {
          const line = doc.lineAt(pos);
          starts.push(line.from);
          if (line.to + 1 > block.to) break;
          pos = line.to + 1;
        }
        starts.forEach((lf, i) => {
          const isOpen = i === 0;
          const isClose = i === starts.length - 1 && starts.length > 1;
          decos.push((isOpen ? fenceOpenDeco : isClose ? fenceCloseDeco : codeLineDeco).range(lf));
        });
        // Copy button pinned to the block's top-right (on the opening fence line).
        const codeNode = block.getChild("CodeText");
        const code = codeNode ? doc.sliceString(codeNode.from, codeNode.to) : "";
        decos.push(
          Decoration.widget({ widget: new CopyButtonWidget(code), side: 1 }).range(doc.lineAt(block.from).to),
        );
        const editing = editIntersects(block.from, block.to);
        if (!editing) {
          for (const m of block.getChildren("CodeMark")) decos.push(hideDeco.range(m.from, m.to));
        }
        return false;
      }

      // Indented code block: just the background.
      if (name === "CodeBlock") {
        let pos = node.from;
        while (true) {
          const line = doc.lineAt(pos);
          decos.push(codeLineDeco.range(line.from));
          if (line.to + 1 > node.to) break;
          pos = line.to + 1;
        }
        return false;
      }

      // GFM table: a real grid when idle, raw monospace source while editing.
      if (name === "Table") {
        const block = node.node;
        const startLine = doc.lineAt(block.from);
        const lastPos = Math.min(block.to, doc.length);
        const endLine = doc.lineAt(lastPos > startLine.from ? lastPos - 1 : startLine.from);
        const editing = editIntersects(startLine.from, endLine.to);
        if (editing) {
          let pos = startLine.from;
          while (true) {
            const line = doc.lineAt(pos);
            decos.push(tableSrcLine.range(line.from));
            if (line.to + 1 > endLine.to) break;
            pos = line.to + 1;
          }
        } else {
          const source = doc.sliceString(startLine.from, endLine.to);
          decos.push(
            Decoration.replace({ widget: new TableWidget(startLine.from, source), block: true }).range(
              startLine.from,
              endLine.to,
            ),
          );
        }
        return false;
      }

      // Inline markers — concealed unless their line is being edited.
      if (CONCEAL_SPACED.has(name)) {
        if (!lineActive(node.from)) concealSpaced(node.from, node.to);
        return false;
      }
      if (CONCEAL_SIMPLE.has(name)) {
        if (!lineActive(node.from)) decos.push(hideDeco.range(node.from, node.to));
        return false;
      }
      // A link gets a pointer cursor (it's clickable) when not being edited.
      if (name === "Link") {
        if (!lineActive(node.from)) decos.push(linkMarkDeco.range(node.from, node.to));
        return undefined; // descend so the marks/URL below still get concealed
      }
      // Links: show just the link text (hide [], (), the URL and any title).
      // Images are left raw — they can't render inline here, so the source is
      // more useful than a mangled fragment.
      if (name === "LinkMark" || name === "URL" || name === "LinkTitle") {
        if (node.node.parent?.name === "Link" && !lineActive(node.from)) {
          decos.push(hideDeco.range(node.from, node.to));
        }
        return false;
      }

      return undefined;
    },
  });

  return Decoration.set(decos, true);
}

// Block decorations (the table widgets) must come from a StateField, not a
// ViewPlugin, since they affect layout/height.
const markdownBlocks = StateField.define<DecorationSet>({
  create: (state) => buildMarkdownDecorations(state),
  update(deco, tr) {
    if (
      tr.docChanged ||
      tr.selection ||
      tr.effects.some((e) => e.is(setFocused) || e.is(setEdit)) ||
      syntaxTree(tr.startState) !== syntaxTree(tr.state)
    ) {
      return buildMarkdownDecorations(tr.state);
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const markdownExtensions: Extension[] = [
  markdown({ base: markdownLanguage, codeLanguages: languages }),
  EditorView.lineWrapping,
  syntaxHighlighting(markdownHighlight),
  syntaxHighlighting(codeHighlight),
  focusField,
  focusWatcher,
  editField,
  editGate,
  anchorNav,
  markdownBlocks,
  baseTheme,
];

/** Find a CodeMirror language for a file by my language id or its filename. */
function matchLanguage(language?: string, filename?: string): LanguageDescription | null {
  if (language) {
    const byName = LanguageDescription.matchLanguageName(languages, language, true);
    if (byName) return byName;
  }
  if (filename) {
    const byFile = LanguageDescription.matchFilename(languages, filename);
    if (byFile) return byFile;
  }
  return null;
}

export default function LiveEditor({
  value,
  onChange,
  kind,
  language,
  filename,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  kind: "markdown" | "code";
  language?: string;
  filename?: string;
  placeholder?: string;
}) {
  // Lazily load the right language support for code files (covers ~140 langs).
  const [codeLang, setCodeLang] = useState<Extension[]>([]);
  useEffect(() => {
    if (kind !== "code") return;
    let cancelled = false;
    const desc = matchLanguage(language, filename);
    // No reset for the no-match case: each file remounts the editor (keyed by
    // rel), so codeLang already starts empty.
    desc?.load().then((support) => {
      if (!cancelled) setCodeLang([support]);
    });
    return () => {
      cancelled = true;
    };
  }, [kind, language, filename]);

  const extensions: Extension[] =
    kind === "markdown"
      ? markdownExtensions
      : [...codeLang, EditorView.lineWrapping, syntaxHighlighting(codeHighlight), baseTheme];

  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      extensions={extensions}
      className={kind === "code" ? "cm-mono" : undefined}
      basicSetup={{
        lineNumbers: false,
        foldGutter: false,
        highlightActiveLine: false,
        highlightActiveLineGutter: false,
        autocompletion: false,
        bracketMatching: false,
        closeBrackets: false,
        highlightSelectionMatches: false,
        searchKeymap: false,
        indentOnInput: false,
        // Use the browser's native selection: CodeMirror's drawn selection sits
        // BEHIND the line backgrounds, so it's invisible inside code blocks.
        drawSelection: false,
      }}
    />
  );
}
