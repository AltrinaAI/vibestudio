"use client";

import { useMemo } from "react";
import hljs from "highlight.js";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export default function CodeView({
  code,
  language,
}: {
  code: string;
  language?: string;
}) {
  const display = useMemo(() => code.replace(/\n$/, ""), [code]);

  const html = useMemo(() => {
    try {
      if (language && hljs.getLanguage(language)) {
        return hljs.highlight(display, { language }).value;
      }
      const auto = hljs.highlightAuto(display);
      return auto.value;
    } catch {
      return escapeHtml(display);
    }
  }, [display, language]);

  const lineCount = display === "" ? 1 : display.split("\n").length;
  const gutter = useMemo(
    () => Array.from({ length: lineCount }, (_, i) => String(i + 1)).join("\n"),
    [lineCount],
  );

  return (
    <div className="codeview overflow-auto rounded-xl border border-border text-[0.82rem] leading-[1.6]">
      <div className="flex min-h-full min-w-max font-mono">
        <pre
          aria-hidden
          className="codeview-gutter shrink-0 select-none px-3 py-3 text-right"
        >
          {gutter}
        </pre>
        <pre className="flex-1 px-4 py-3">
          <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
        </pre>
      </div>
    </div>
  );
}
