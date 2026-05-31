# Agent Skill Viewer & Editor

A local Next.js app that renders a single **[Agent Skill](https://agentskills.io/specification)**
folder in a human-readable way — with metadata badges, spec validation, syntax
highlighting, a file browser, and in-place editing.

## What it understands

A skill is a directory containing a required `SKILL.md` (YAML frontmatter +
Markdown body) plus optional `scripts/`, `references/`, `assets/` and any other
files. This tool:

- **Renders `SKILL.md`** — `name`, `description`, `license`, `compatibility`,
  `allowed-tools` (as chips), and `metadata`, followed by the Markdown body with
  GitHub-flavored Markdown and code highlighting.
- **Validates against the spec** — name pattern & folder-name match, description
  length, the 500-char `compatibility` limit, metadata shape, body size
  advisories (≤ 500 lines / ≈ 5000 tokens), and broken/too-deep file references.
- **Browses files** — a tree of the whole skill folder; click any file to view it
  with syntax highlighting (or render it, for Markdown; or preview, for images).
- **Edits** — a form for the frontmatter fields plus a CodeMirror editor with live
  preview for the body, and a plain editor for any other text file. Changes are
  written back to disk.

## Run it

```bash
npm install
npm run dev          # http://localhost:3000
```

Then paste an absolute path to a skill folder into the top bar and press
**Load**, or open one of the bundled examples in `examples/`.

To open a folder automatically on startup:

```bash
SKILL_PATH=/absolute/path/to/my-skill npm run dev
# or visit  http://localhost:3000/?path=/absolute/path/to/my-skill
```

## Examples

`examples/` contains real document skills (`docx`, `pdf`, `pptx`, `xlsx`) used by
the welcome screen — each ships a `SKILL.md`, a `scripts/` directory, a bundled
license, and (for `pdf`/`pptx`) additional reference docs.

## Notes

- File reads and writes are constrained to the loaded skill directory (no `..`
  escapes). It's a local developer tool — run it on folders you trust.
- Markdown is rendered without raw-HTML passthrough, so embedded `<script>` etc.
  are not executed.
