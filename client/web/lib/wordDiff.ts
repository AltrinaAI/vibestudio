export type DiffSeg = { type: "same" | "add" | "del"; text: string };

/** Split into word + whitespace tokens, keeping the whitespace so the rendered
 *  diff preserves spacing and line breaks. */
function tokenize(s: string): string[] {
  return s.split(/(\s+)/).filter((t) => t.length > 0);
}

/**
 * Word-level diff of two short strings (a skill name or description) via LCS.
 * Returns merged runs of unchanged / added / removed text. O(n·m) — intended for
 * short fields, not large documents.
 */
export function wordDiff(before: string, after: string): DiffSeg[] {
  const A = tokenize(before);
  const B = tokenize(after);
  const n = A.length;
  const m = B.length;

  // dp[i][j] = length of the longest common subsequence of A[i:] and B[j:].
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out: DiffSeg[] = [];
  const push = (type: DiffSeg["type"], text: string) => {
    const last = out[out.length - 1];
    if (last && last.type === type) last.text += text;
    else out.push({ type, text });
  };

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      push("same", A[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push("del", A[i++]);
    } else {
      push("add", B[j++]);
    }
  }
  while (i < n) push("del", A[i++]);
  while (j < m) push("add", B[j++]);
  return out;
}
