// Pure (no fs) helpers for parsing and verifying AGENTS.md — the cross-agent
// project-guide standard (https://agents.md). Shared between discovery cards and
// the live editor; reuses the skill validator's issue shape so the verification
// UI (ValidationPill) is identical for both.
//
// Unlike SKILL.md, an AGENTS.md has NO required schema: it is "just Markdown"
// that an agent reads on task start. So the `agentmd` check is a best-PRACTICES
// lint, not a conformance gate — it flags the few things that actually break the
// standard (a wrong file name, an empty guide) and otherwise nudges toward the
// conventions agents rely on: a title, the setup/build/test/convention sections,
// and a size that won't crowd the agent's context.

import {
  type ValidationIssue,
  splitFrontmatter,
  estimateTokens,
  countLines,
} from "@/lib/skill";

export { summarizeIssues } from "@/lib/skill";

/** The canonical file name of the standard. */
export const GUIDE_FILENAME = "AGENTS.md";

export const AGENTS_LIMITS = {
  bodyMaxLines: 400,
  bodyMaxTokens: 4000,
} as const;

export interface ParsedAgentsMd {
  /** A leading YAML `---` block was present (not part of the standard). */
  hasFrontmatter: boolean;
  /** Markdown body (frontmatter stripped, if any). */
  body: string;
  /** First H1 (`# …`) title, if present. */
  title: string | null;
  /** Heading texts (any level), lowercased, in document order. */
  headings: string[];
}

/** Split off any (non-standard) frontmatter, then collect the title + headings,
 *  skipping fenced code blocks so a `# comment` inside ``` isn't read as one. */
export function parseAgentsMd(raw: string): ParsedAgentsMd {
  const { hasFrontmatter, body } = splitFrontmatter(raw);
  const headings: string[] = [];
  let title: string | null = null;
  let inFence = false;
  for (const line of body.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const text = m[2].trim();
    headings.push(text.toLowerCase());
    if (m[1].length === 1 && title == null) title = text;
  }
  return { hasFrontmatter, body, title, headings };
}

/** Sections agents conventionally look for. Matched loosely (a heading that
 *  CONTAINS any keyword counts), so phrasing is free. */
interface SectionHint {
  label: string;
  keywords: string[];
}
const RECOMMENDED: SectionHint[] = [
  { label: "Setup / install", keywords: ["setup", "install", "getting started", "environment", "prerequisite"] },
  { label: "Build & run commands", keywords: ["build", "run", "dev", "command", "script"] },
  { label: "Testing & checks", keywords: ["test", "lint", "check", "ci", "typecheck"] },
  { label: "Code style / conventions", keywords: ["style", "convention", "guideline", "format", "pattern"] },
  { label: "Project structure", keywords: ["structure", "layout", "architecture", "overview", "codebase"] },
];

export interface AgentsValidationInput {
  /** Full AGENTS.md document (frontmatter + body). */
  raw: string;
  /** File name on disk, for the naming check (normally "AGENTS.md"). */
  fileName?: string;
}

/** Verify an AGENTS.md against the standard's conventions (the `agentmd` check). */
export function validateAgentsMd(input: AgentsValidationInput): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const { raw, fileName } = input;
  const { body, title, headings, hasFrontmatter } = parseAgentsMd(raw);

  // --- file name — the closest thing the standard has to a MUST -------------
  if (fileName && fileName.toLowerCase() !== GUIDE_FILENAME.toLowerCase()) {
    issues.push({
      level: "error",
      field: "file",
      message: `"${fileName}" is not the standard guide file. Agents read \`${GUIDE_FILENAME}\`.`,
    });
  } else if (fileName && fileName !== GUIDE_FILENAME) {
    issues.push({
      level: "warning",
      field: "file",
      message: `File is named "${fileName}"; the standard spells it "${GUIDE_FILENAME}", and some agents match case-sensitively.`,
    });
  }

  // --- non-empty ------------------------------------------------------------
  if (body.trim() === "") {
    issues.push({
      level: "error",
      field: "body",
      message: "The guide is empty. Add the setup/build/test commands and conventions an agent needs.",
    });
    return issues;
  }

  // --- title ----------------------------------------------------------------
  if (title == null) {
    issues.push({
      level: "warning",
      field: "title",
      message: "No top-level `# ` heading. Start with a title so the guide is self-describing.",
    });
  }

  // --- recommended sections (advisory) -------------------------------------
  for (const s of RECOMMENDED) {
    const present = headings.some((h) => s.keywords.some((k) => h.includes(k)));
    if (!present) {
      issues.push({
        level: "info",
        field: "sections",
        message: `Consider a "${s.label}" section — agents look for it to work in your project.`,
      });
    }
  }

  // --- size — the whole file is read every task ----------------------------
  const lines = countLines(body);
  if (lines > AGENTS_LIMITS.bodyMaxLines) {
    issues.push({
      level: "warning",
      field: "size",
      message: `Guide is ${lines} lines; agents read the whole file every task. Keep it under ~${AGENTS_LIMITS.bodyMaxLines} and link out to detail.`,
    });
  }
  const tokens = estimateTokens(body);
  if (tokens > AGENTS_LIMITS.bodyMaxTokens) {
    issues.push({
      level: "warning",
      field: "size",
      message: `Guide is ~${tokens} tokens; trim it so it doesn't crowd the agent's context window.`,
    });
  }

  // --- frontmatter note (advisory) -----------------------------------------
  if (hasFrontmatter) {
    issues.push({
      level: "info",
      field: "frontmatter",
      message: "YAML frontmatter isn't part of the AGENTS.md standard — most agents ignore it. Put guidance in the Markdown body.",
    });
  }

  return issues;
}
