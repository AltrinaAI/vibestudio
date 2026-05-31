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
  { tag: t.list, color: "var(--muted)" },
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
    const lines = this.source.split("\n").filter((l) => l.trim());
    const rows = lines.map(splitRow);
    let header: string[] | null = null;
    let aligns: string[] = [];
    let body = rows;
    if (rows.length >= 2 && isDelimiterRow(rows[1])) {
      header = rows[0];
      aligns = rows[1].map(alignOf);
      body = rows.slice(2);
    }

    const table = document.createElement("table");
    table.className = "cm-md-rendered-table";
    if (header) {
      const thead = document.createElement("thead");
      const tr = document.createElement("tr");
      header.forEach((cell, i) => {
        const th = document.createElement("th");
        if (aligns[i]) th.style.textAlign = aligns[i];
        th.innerHTML = inlineMd(cell);
        tr.appendChild(th);
      });
      thead.appendChild(tr);
      table.appendChild(thead);
    }
    const tbody = document.createElement("tbody");
    body.forEach((r) => {
      const tr = document.createElement("tr");
      r.forEach((cell, i) => {
        const td = document.createElement("td");
        if (aligns[i]) td.style.textAlign = aligns[i];
        td.innerHTML = inlineMd(cell);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    const wrap = document.createElement("div");
    wrap.className = "cm-md-table-wrap";
    wrap.appendChild(table);
    const from = this.from;
    wrap.addEventListener("mousedown", (e) => {
      e.preventDefault();
      view.dispatch({ selection: { anchor: from }, scrollIntoView: true });
      view.focus();
    });
    return wrap;
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
    view.dispatch({ effects: setFocused.of(false) });
  },
});

function buildMarkdownDecorations(state: EditorState): DecorationSet {
  const doc = state.doc;
  const tree = syntaxTree(state);
  const sel = state.selection.ranges;
  const focused = state.field(focusField, false);
  const decos: Range<Decoration>[] = [];

  // Lines touched by a selection (only while focused) reveal their raw markup so
  // they can be edited — "click the line to see the markdown" behaviour.
  const activeLines = new Set<number>();
  if (focused) {
    for (const r of sel) {
      const first = doc.lineAt(r.from).number;
      const last = doc.lineAt(r.to).number;
      for (let n = first; n <= last; n++) activeLines.add(n);
    }
  }
  const lineActive = (pos: number) => activeLines.has(doc.lineAt(pos).number);

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
        const editing = focused && sel.some((r) => r.from <= block.to && r.to >= block.from);
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
        const editing = focused && sel.some((r) => r.from <= endLine.to && r.to >= startLine.from);
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
      tr.effects.some((e) => e.is(setFocused)) ||
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
      }}
    />
  );
}
