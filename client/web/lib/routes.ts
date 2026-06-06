// URL <-> skill identity helpers for the hash router.
//
// A skill root is an absolute filesystem path (with slashes), so it rides as a
// single `:root` segment via encodeURIComponent; React Router decodes params on
// read, so consumers use `useParams().root` directly (do NOT decode again, or a
// path containing a literal "%" double-decodes). A file's rel path also has
// slashes, so it rides as a `file/*` splat with each segment encoded; the router
// decodes the splat on read.

/** The dedicated secret-manager page (machine-local store + future providers). */
export const secretsPath = () => "/secrets";

/** The AGENTS.md guide editor, keyed by the guide file's absolute path (which
 *  contains slashes, so it rides as a single encoded `:path` segment — decoded
 *  by the router on read, exactly like a skill `:root`). */
export const agentMdPath = (path: string) => `/agents/${encodeURIComponent(path)}`;

export const studioPath = (root: string) => `/studio/${encodeURIComponent(root)}`;

export const studioFilePath = (root: string, rel: string) =>
  `${studioPath(root)}/file/${rel.split("/").map(encodeURIComponent).join("/")}`;

/** Read-only diff for a commit (a hex SHA) or the working tree ("worktree"). */
export const studioCommitPath = (root: string, sha: string) =>
  `${studioPath(root)}/commit/${encodeURIComponent(sha)}`;
