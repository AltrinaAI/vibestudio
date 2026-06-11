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

/** The terminals workspace (always-mounted host; the URL just reveals it).
 *  Pass a session id to land with that terminal selected (e.g. jumping into
 *  the mining run's conversation); the workspace consumes the param. */
export const terminalsPath = (id?: string) =>
  id ? `/terminals?id=${encodeURIComponent(id)}` : "/terminals";

export const studioPath = (root: string) => `/studio/${encodeURIComponent(root)}`;

export const studioFilePath = (root: string, rel: string) =>
  `${studioPath(root)}/file/${rel.split("/").map(encodeURIComponent).join("/")}`;

/** Read-only diff for a commit (a hex SHA) or the working tree ("worktree"). */
export const studioCommitPath = (root: string, sha: string) =>
  `${studioPath(root)}/commit/${encodeURIComponent(sha)}`;

/** Open a loose markdown file (outside any skill) by its absolute path. The path
 *  rides as a single encoded `:path` segment, like `studioPath`'s `:root`; the
 *  router decodes it on read, so consumers use `useParams().path` directly. */
export const markdownPath = (absPath: string) => `/markdown/${encodeURIComponent(absPath)}`;
