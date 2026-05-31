"use client";

import CodeMirror from "@uiw/react-codemirror";
import { oneDark } from "@codemirror/theme-one-dark";
import { markdown } from "@codemirror/lang-markdown";
import { yaml } from "@codemirror/lang-yaml";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { json } from "@codemirror/lang-json";
import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

function extensionsFor(language?: string): Extension[] {
  switch (language) {
    case "markdown":
      return [markdown()];
    case "yaml":
      return [yaml()];
    case "json":
      return [json()];
    case "python":
      return [python()];
    case "javascript":
      return [javascript({ jsx: true })];
    case "typescript":
      return [javascript({ jsx: true, typescript: true })];
    default:
      return [];
  }
}

export default function CodeEditor({
  value,
  language,
  onChange,
  height = "420px",
  readOnly = false,
  className,
}: {
  value: string;
  language?: string;
  onChange?: (value: string) => void;
  height?: string;
  readOnly?: boolean;
  className?: string;
}) {
  return (
    <CodeMirror
      value={value}
      className={className}
      theme={oneDark}
      height={height}
      readOnly={readOnly}
      extensions={[...extensionsFor(language), EditorView.lineWrapping]}
      onChange={onChange}
      basicSetup={{
        lineNumbers: true,
        highlightActiveLine: !readOnly,
        highlightActiveLineGutter: !readOnly,
        foldGutter: true,
        autocompletion: false,
      }}
    />
  );
}
