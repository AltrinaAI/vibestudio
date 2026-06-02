// URL <-> skill identity helpers for the hash router.
//
// A skill root is an absolute filesystem path (with slashes), so it rides as a
// single `:root` segment via encodeURIComponent; React Router decodes params on
// read, so consumers use `useParams().root` directly (do NOT decode again, or a
// path containing a literal "%" double-decodes). A file's rel path also has
// slashes, so it rides as a `file/*` splat with each segment encoded; the router
// decodes the splat on read.

export const studioPath = (root: string) => `/studio/${encodeURIComponent(root)}`;

export const studioFilePath = (root: string, rel: string) =>
  `${studioPath(root)}/file/${rel.split("/").map(encodeURIComponent).join("/")}`;
