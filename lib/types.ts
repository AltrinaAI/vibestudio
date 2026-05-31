// Shared API payload types (client + server).
import type { SkillFrontmatter, ValidationIssue } from "./skill";
import type { FileCategory } from "./fileTypes";

export interface TreeNode {
  name: string;
  /** Path relative to the skill root, POSIX-style. "" for the root. */
  rel: string;
  type: "file" | "dir";
  size?: number;
  category?: FileCategory;
  language?: string;
  label?: string;
  glyph?: string;
  isSkillMd?: boolean;
  children?: TreeNode[];
}

export interface SkillStats {
  bodyLines: number;
  bodyTokens: number;
  fileCount: number;
  dirCount: number;
  totalBytes: number;
}

export interface SkillData {
  root: string;
  dirName: string;
  raw: string;
  frontmatter: SkillFrontmatter;
  frontmatterRaw: string;
  body: string;
  hasFrontmatter: boolean;
  parseError?: string;
  tree: TreeNode[];
  files: string[];
  validation: ValidationIssue[];
  stats: SkillStats;
}

export interface FileData {
  rel: string;
  category: FileCategory;
  language: string;
  label: string;
  size: number;
  content?: string;
  truncated?: boolean;
  tooLarge?: boolean;
  isBinary?: boolean;
}

export interface ApiError {
  error: string;
}
