// URL <-> skill identity helpers for the hash router.
//
// The route URLs use the nav vocabulary — /skills, /sessions, /credentials — while
// these helper NAMES keep the older internal vocabulary (studio/terminals/secrets);
// renaming the functions is deferred to the wider code-vocabulary alignment.
//
// A skill root is an absolute filesystem path (with slashes), so it rides as a
// single `:root` segment via encodeURIComponent; React Router decodes params on
// read, so consumers use `useParams().root` directly (do NOT decode again, or a
// path containing a literal "%" double-decodes). A file's rel path also has
// slashes, so it rides as a `file/*` splat with each segment encoded; the router
// decodes the splat on read.

/** The dedicated Credentials page (machine-local secrets store + OAuth connections). */
export const secretsPath = () => "/credentials";

/** The mining page: the latest run's record and the files in its run dir. */
export const miningPath = () => "/mining";

/** The Sessions workspace (always-mounted host; the URL just reveals it).
 *  Pass a session id to land with that terminal selected (e.g. jumping into
 *  the mining run's conversation); the workspace consumes the param. */
export const terminalsPath = (id?: string) =>
  id ? `/sessions?id=${encodeURIComponent(id)}` : "/sessions";

export const studioPath = (root: string) => `/skills/${encodeURIComponent(root)}`;

export const studioFilePath = (root: string, rel: string) =>
  `${studioPath(root)}/file/${rel.split("/").map(encodeURIComponent).join("/")}`;

/** Read-only diff for a commit (a hex SHA) or the working tree ("worktree"). */
export const studioCommitPath = (root: string, sha: string) =>
  `${studioPath(root)}/commit/${encodeURIComponent(sha)}`;

/** Open a loose markdown file (outside any skill) by its absolute path. The path
 *  rides as a single encoded `:path` segment, like `studioPath`'s `:root`; the
 *  router decodes it on read, so consumers use `useParams().path` directly. */
export const markdownPath = (absPath: string) => `/markdown/${encodeURIComponent(absPath)}`;
