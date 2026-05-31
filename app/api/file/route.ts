import { NextResponse } from "next/server";
import { readFileForView, writeTextFile, HttpError } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function fail(err: unknown) {
  if (err instanceof HttpError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  const message = err instanceof Error ? err.message : "Unknown error";
  return NextResponse.json({ error: message }, { status: 500 });
}

// GET /api/file?root=/abs&rel=scripts/x.py  -> file content + metadata
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const root = searchParams.get("root");
  const rel = searchParams.get("rel");
  if (!root || !rel) {
    return NextResponse.json({ error: "Missing `root` or `rel`." }, { status: 400 });
  }
  try {
    return NextResponse.json(await readFileForView(root, rel));
  } catch (err) {
    return fail(err);
  }
}

// POST /api/file  { root, rel, content }  -> write a text file
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { root?: string; rel?: string; content?: string };
    if (!body.root || !body.rel) {
      return NextResponse.json({ error: "Missing `root` or `rel`." }, { status: 400 });
    }
    if (typeof body.content !== "string") {
      return NextResponse.json({ error: "`content` must be a string." }, { status: 400 });
    }
    await writeTextFile(body.root, body.rel, body.content);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return fail(err);
  }
}
