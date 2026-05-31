import { NextResponse } from "next/server";
import { loadSkill, saveSkillMd, HttpError } from "@/lib/server";
import type { SkillFrontmatter } from "@/lib/skill";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function fail(err: unknown) {
  if (err instanceof HttpError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  const message = err instanceof Error ? err.message : "Unknown error";
  return NextResponse.json({ error: message }, { status: 500 });
}

// GET /api/skill?path=/abs/path/to/skill  -> full analyzed skill
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const p = searchParams.get("path");
  if (!p) return NextResponse.json({ error: "Missing `path` query parameter." }, { status: 400 });
  try {
    return NextResponse.json(await loadSkill(p));
  } catch (err) {
    return fail(err);
  }
}

// POST /api/skill  { root, frontmatter, body }  -> save SKILL.md, return reloaded skill
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      root?: string;
      frontmatter?: SkillFrontmatter;
      body?: string;
    };
    if (!body.root) return NextResponse.json({ error: "Missing `root`." }, { status: 400 });
    if (!body.frontmatter || typeof body.frontmatter !== "object") {
      return NextResponse.json({ error: "Missing `frontmatter`." }, { status: 400 });
    }
    await saveSkillMd(body.root, body.frontmatter, body.body ?? "");
    return NextResponse.json(await loadSkill(body.root));
  } catch (err) {
    return fail(err);
  }
}
