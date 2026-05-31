import { NextResponse } from "next/server";
import { readRawBytes, HttpError } from "@/lib/server";
import { getExtension } from "@/lib/fileTypes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
};

// GET /api/raw?root=/abs&rel=assets/diagram.png  -> raw bytes (for <img>)
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const root = searchParams.get("root");
  const rel = searchParams.get("rel");
  if (!root || !rel) {
    return NextResponse.json({ error: "Missing `root` or `rel`." }, { status: 400 });
  }
  try {
    const { buf } = await readRawBytes(root, rel);
    const ext = getExtension(rel);
    const type = MIME[ext] ?? "application/octet-stream";
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        "Content-Type": type,
        "Cache-Control": "no-store",
        // SVGs are served for <img> display only; CSP blocks inline scripts.
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
      },
    });
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: "Failed to read file." }, { status: 500 });
  }
}
