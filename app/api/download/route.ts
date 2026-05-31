import { NextResponse } from "next/server";
import { zipSkill, HttpError } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/download?path=/abs/path/to/skill  -> skill.zip (attachment)
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const root = searchParams.get("path") ?? searchParams.get("root");
  if (!root) {
    return NextResponse.json({ error: "Missing `path`." }, { status: 400 });
  }
  try {
    const { buf, filename } = await zipSkill(root);
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": String(buf.length),
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: "Failed to package skill." }, { status: 500 });
  }
}
