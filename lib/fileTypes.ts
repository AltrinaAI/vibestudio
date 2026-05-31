// Maps file extensions to display category, syntax-highlight language and a glyph.
// Pure module — safe to import on both client and server.

export type FileCategory = "markdown" | "code" | "data" | "image" | "text" | "binary";

export interface FileTypeInfo {
  /** highlight.js language id (also used to pick a CodeMirror language). */
  language: string;
  category: FileCategory;
  /** Short human label, e.g. "Python". */
  label: string;
  /** Emoji glyph for the file tree. */
  glyph: string;
}

const DEFAULT: FileTypeInfo = { language: "plaintext", category: "text", label: "Text", glyph: "📄" };

const BY_EXT: Record<string, FileTypeInfo> = {
  md: { language: "markdown", category: "markdown", label: "Markdown", glyph: "📝" },
  markdown: { language: "markdown", category: "markdown", label: "Markdown", glyph: "📝" },
  mdx: { language: "markdown", category: "markdown", label: "MDX", glyph: "📝" },

  py: { language: "python", category: "code", label: "Python", glyph: "🐍" },
  sh: { language: "bash", category: "code", label: "Shell", glyph: "🐚" },
  bash: { language: "bash", category: "code", label: "Shell", glyph: "🐚" },
  zsh: { language: "bash", category: "code", label: "Shell", glyph: "🐚" },
  ps1: { language: "powershell", category: "code", label: "PowerShell", glyph: "🐚" },

  js: { language: "javascript", category: "code", label: "JavaScript", glyph: "📜" },
  mjs: { language: "javascript", category: "code", label: "JavaScript", glyph: "📜" },
  cjs: { language: "javascript", category: "code", label: "JavaScript", glyph: "📜" },
  jsx: { language: "javascript", category: "code", label: "JSX", glyph: "📜" },
  ts: { language: "typescript", category: "code", label: "TypeScript", glyph: "📜" },
  tsx: { language: "typescript", category: "code", label: "TSX", glyph: "📜" },

  rb: { language: "ruby", category: "code", label: "Ruby", glyph: "💎" },
  go: { language: "go", category: "code", label: "Go", glyph: "🐹" },
  rs: { language: "rust", category: "code", label: "Rust", glyph: "🦀" },
  java: { language: "java", category: "code", label: "Java", glyph: "☕" },
  c: { language: "c", category: "code", label: "C", glyph: "📜" },
  h: { language: "c", category: "code", label: "C Header", glyph: "📜" },
  cpp: { language: "cpp", category: "code", label: "C++", glyph: "📜" },
  php: { language: "php", category: "code", label: "PHP", glyph: "📜" },

  json: { language: "json", category: "data", label: "JSON", glyph: "🗂️" },
  jsonc: { language: "json", category: "data", label: "JSONC", glyph: "🗂️" },
  yaml: { language: "yaml", category: "data", label: "YAML", glyph: "🗂️" },
  yml: { language: "yaml", category: "data", label: "YAML", glyph: "🗂️" },
  toml: { language: "ini", category: "data", label: "TOML", glyph: "🗂️" },
  ini: { language: "ini", category: "data", label: "INI", glyph: "🗂️" },
  xml: { language: "xml", category: "data", label: "XML", glyph: "🗂️" },
  csv: { language: "plaintext", category: "data", label: "CSV", glyph: "📊" },
  tsv: { language: "plaintext", category: "data", label: "TSV", glyph: "📊" },

  html: { language: "xml", category: "code", label: "HTML", glyph: "🌐" },
  htm: { language: "xml", category: "code", label: "HTML", glyph: "🌐" },
  css: { language: "css", category: "code", label: "CSS", glyph: "🎨" },
  scss: { language: "scss", category: "code", label: "SCSS", glyph: "🎨" },
  sql: { language: "sql", category: "code", label: "SQL", glyph: "🗄️" },

  txt: { language: "plaintext", category: "text", label: "Text", glyph: "📄" },
  text: { language: "plaintext", category: "text", label: "Text", glyph: "📄" },
  log: { language: "plaintext", category: "text", label: "Log", glyph: "📄" },

  png: { language: "", category: "image", label: "PNG", glyph: "🖼️" },
  jpg: { language: "", category: "image", label: "JPEG", glyph: "🖼️" },
  jpeg: { language: "", category: "image", label: "JPEG", glyph: "🖼️" },
  gif: { language: "", category: "image", label: "GIF", glyph: "🖼️" },
  webp: { language: "", category: "image", label: "WebP", glyph: "🖼️" },
  bmp: { language: "", category: "image", label: "BMP", glyph: "🖼️" },
  ico: { language: "", category: "image", label: "Icon", glyph: "🖼️" },
  svg: { language: "xml", category: "image", label: "SVG", glyph: "🖼️" },
};

const BY_FILENAME: Record<string, FileTypeInfo> = {
  Dockerfile: { language: "dockerfile", category: "code", label: "Dockerfile", glyph: "🐳" },
  Makefile: { language: "makefile", category: "code", label: "Makefile", glyph: "🛠️" },
  ".gitignore": { language: "plaintext", category: "text", label: "gitignore", glyph: "📄" },
};

export function getExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "";
  return name.slice(dot + 1).toLowerCase();
}

export function getFileType(name: string): FileTypeInfo {
  if (BY_FILENAME[name]) return BY_FILENAME[name];
  const ext = getExtension(name);
  return BY_EXT[ext] ?? DEFAULT;
}

export function isImage(name: string): boolean {
  return getFileType(name).category === "image";
}

/** Whether a file is a text-like category we render with syntax highlighting. */
export function isTextual(name: string): boolean {
  const c = getFileType(name).category;
  return c === "markdown" || c === "code" || c === "data" || c === "text";
}

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
