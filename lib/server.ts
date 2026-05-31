// Server-only filesystem layer. Imported exclusively from route handlers.
import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import JSZip from "jszip";

import {
  parseSkillMd,
  serializeSkillMd,
  validateSkill,
  estimateTokens,
  countLines,
  type SkillFrontmatter,
} from "./skill";
import { getFileType, isImage, isTextual } from "./fileTypes";
import type { SkillData, TreeNode, FileData } from "./types";

const MAX_TEXT_BYTES = 2 * 1024 * 1024; // 2 MB
const MAX_TREE_ENTRIES = 5000;
const IGNORED_DIRS = new Set([".git", "node_modules", ".next", "__pycache__", ".venv"]);

/** Expand a leading ~ and resolve to an absolute, normalized path. */
export function resolveRoot(input: string): string {
  let p = input.trim();
  if (p === "~" || p.startsWith("~/")) {
    p = path.join(os.homedir(), p.slice(1));
  }
  return path.resolve(p);
}

/** Lexically resolve a relative path inside `root`, refusing `..`/absolute escapes. */
export function safeResolve(root: string, rel: string): string {
  const cleaned = rel.replace(/\\/g, "/").replace(/^\/+/, "");
  const abs = path.resolve(root, cleaned);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (abs !== root && !abs.startsWith(rootWithSep)) {
    throw new HttpError(400, "Path escapes the skill directory.");
  }
  return abs;
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function realpathOrNull(p: string): Promise<string | null> {
  try {
    return await fs.realpath(p);
  } catch {
    return null;
  }
}

/**
 * Resolve `rel` within `root` AND canonicalize with realpath so a symlink that
 * lives inside the skill folder but points outside it cannot escape the root.
 * For writes (mustExist: false) we canonicalize the nearest existing ancestor,
 * since the target file may not exist yet.
 */
export async function resolveWithinReal(
  root: string,
  rel: string,
  opts: { mustExist: boolean },
): Promise<string> {
  const abs = safeResolve(root, rel); // lexical gate first
  const realRoot = await realpathOrNull(root);
  if (realRoot === null) throw new HttpError(404, "Skill directory not found.");

  let probe = abs;
  let realProbe = await realpathOrNull(probe);
  while (realProbe === null) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
    realProbe = await realpathOrNull(probe);
  }
  if (realProbe === null) throw new HttpError(400, "Path escapes the skill directory.");

  const rootWithSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  if (realProbe !== realRoot && !realProbe.startsWith(rootWithSep)) {
    throw new HttpError(400, "Path escapes the skill directory.");
  }
  if (opts.mustExist && (await realpathOrNull(abs)) === null) {
    throw new HttpError(404, `File not found: ${rel}`);
  }
  return abs;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function toPosix(rel: string): string {
  return rel.split(path.sep).join("/");
}

interface BuildResult {
  tree: TreeNode[];
  files: string[];
  fileCount: number;
  dirCount: number;
  totalBytes: number;
}

/** Recursively build the file tree under `root`, sorted dirs-first then alphabetically. */
async function buildTree(root: string): Promise<BuildResult> {
  const files: string[] = [];
  let fileCount = 0;
  let dirCount = 0;
  let totalBytes = 0;
  let entryBudget = MAX_TREE_ENTRIES;

  async function walk(dir: string): Promise<TreeNode[]> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    entries.sort((a, b) => {
      const ad = a.isDirectory() ? 0 : 1;
      const bd = b.isDirectory() ? 0 : 1;
      if (ad !== bd) return ad - bd;
      return a.name.localeCompare(b.name);
    });

    const nodes: TreeNode[] = [];
    for (const entry of entries) {
      if (entryBudget-- <= 0) break;
      if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;

      const abs = path.join(dir, entry.name);
      const rel = toPosix(path.relative(root, abs));

      if (entry.isDirectory()) {
        dirCount++;
        const children = await walk(abs);
        nodes.push({ name: entry.name, rel, type: "dir", children });
      } else if (entry.isFile()) {
        fileCount++;
        let size = 0;
        try {
          size = (await fs.stat(abs)).size;
        } catch {
          /* ignore */
        }
        totalBytes += size;
        files.push(rel);
        const info = getFileType(entry.name);
        nodes.push({
          name: entry.name,
          rel,
          type: "file",
          size,
          category: info.category,
          language: info.language,
          label: info.label,
          glyph: info.glyph,
          isSkillMd: rel === "SKILL.md",
        });
      }
    }
    return nodes;
  }

  const tree = await walk(root);
  return { tree, files, fileCount, dirCount, totalBytes };
}

/** Load and fully analyze a skill directory. Throws HttpError on bad input. */
export async function loadSkill(input: string): Promise<SkillData> {
  const root = resolveRoot(input);

  let stat: import("node:fs").Stats;
  try {
    stat = await fs.stat(root);
  } catch {
    throw new HttpError(404, `Path not found: ${root}`);
  }
  if (!stat.isDirectory()) {
    throw new HttpError(400, `Not a directory: ${root}`);
  }

  const skillMdPath = path.join(root, "SKILL.md");
  if (!(await pathExists(skillMdPath))) {
    throw new HttpError(422, `No SKILL.md found in ${root}. A skill directory must contain a SKILL.md file.`);
  }

  const raw = await fs.readFile(skillMdPath, "utf8");
  const parsed = parseSkillMd(raw);
  const { tree, files, fileCount, dirCount, totalBytes } = await buildTree(root);
  const dirName = path.basename(root);

  const validation = validateSkill({
    frontmatter: parsed.frontmatter,
    body: parsed.body,
    hasFrontmatter: parsed.hasFrontmatter,
    parseError: parsed.parseError,
    dirName,
    files,
  });

  return {
    root,
    dirName,
    raw,
    frontmatter: parsed.frontmatter,
    frontmatterRaw: parsed.frontmatterRaw,
    body: parsed.body,
    hasFrontmatter: parsed.hasFrontmatter,
    parseError: parsed.parseError,
    tree,
    files,
    validation,
    stats: {
      bodyLines: countLines(parsed.body),
      bodyTokens: estimateTokens(parsed.body),
      fileCount,
      dirCount,
      totalBytes,
    },
  };
}

/** Read a single file for display. Images return metadata only (fetched via /api/raw). */
export async function readFileForView(root: string, rel: string): Promise<FileData> {
  const abs = await resolveWithinReal(root, rel, { mustExist: true });
  const stat = await fs.stat(abs);
  if (!stat.isFile()) {
    throw new HttpError(400, `Not a file: ${rel}`);
  }

  const name = path.basename(abs);
  const info = getFileType(name);
  const base: FileData = {
    rel,
    category: info.category,
    language: info.language,
    label: info.label,
    size: stat.size,
  };

  if (isImage(name)) {
    return base;
  }

  if (stat.size > MAX_TEXT_BYTES) {
    return { ...base, tooLarge: true };
  }

  const buf = await fs.readFile(abs);
  // Treat unknown extensions with NUL bytes as binary.
  if (!isTextual(name) && buf.includes(0)) {
    return { ...base, isBinary: true, category: "binary" };
  }

  return { ...base, content: buf.toString("utf8") };
}

/** Read raw bytes (for serving images). */
export async function readRawBytes(root: string, rel: string): Promise<{ buf: Buffer; abs: string }> {
  const abs = await resolveWithinReal(root, rel, { mustExist: true });
  const stat = await fs.stat(abs);
  if (!stat.isFile()) throw new HttpError(404, `File not found: ${rel}`);
  const buf = await fs.readFile(abs);
  return { buf, abs };
}

/** Write a text file inside the skill (must resolve within root). */
export async function writeTextFile(root: string, rel: string, content: string): Promise<void> {
  const abs = await resolveWithinReal(root, rel, { mustExist: false });
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
}

/** Package an entire skill directory into a zip (named after the folder). */
export async function zipSkill(input: string): Promise<{ buf: Buffer; filename: string }> {
  const root = resolveRoot(input);
  const stat = await fs.stat(root).catch(() => null);
  if (!stat || !stat.isDirectory()) throw new HttpError(404, `Skill not found: ${root}`);
  if (!(await pathExists(path.join(root, "SKILL.md")))) {
    throw new HttpError(422, "Not a skill directory (no SKILL.md).");
  }

  const dirName = path.basename(root);
  const zip = new JSZip();
  const MAX_TOTAL = 100 * 1024 * 1024; // 100 MB safety cap
  let total = 0;

  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue; // never follow symlinks out of the skill
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        await walk(path.join(dir, entry.name), `${prefix}${entry.name}/`);
      } else if (entry.isFile()) {
        const abs = path.join(dir, entry.name);
        const st = await fs.stat(abs).catch(() => null);
        if (!st) continue;
        total += st.size;
        if (total > MAX_TOTAL) throw new HttpError(413, "Skill is too large to download.");
        zip.file(`${dirName}/${prefix}${entry.name}`, await fs.readFile(abs));
      }
    }
  }

  await walk(root, "");
  const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  return { buf, filename: `${dirName}.zip` };
}

/** Serialize and write the SKILL.md frontmatter + body. */
export async function saveSkillMd(
  root: string,
  frontmatter: SkillFrontmatter,
  body: string,
): Promise<void> {
  const serialized = serializeSkillMd(frontmatter, body);
  await writeTextFile(root, "SKILL.md", serialized);
}
