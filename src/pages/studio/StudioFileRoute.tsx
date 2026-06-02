import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { Spinner } from "@/components/ui";
import * as api from "@/lib/api";
import type { FileData } from "@/lib/types";
import FilePane from "./FilePane";
import { useStudio } from "./StudioContext";

/** `/studio/:root/file/*` — loads the selected file and renders its pane. The
 *  `reqRef` guard drops a stale read that resolves after the user has navigated
 *  to a different file. */
export function Component() {
  const { data, afterSave } = useStudio();
  const rel = useParams()["*"] ?? "";
  const [fileData, setFileData] = useState<FileData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const reqRef = useRef(0);

  useEffect(() => {
    const myReq = ++reqRef.current;
    setLoading(true);
    setError(null);
    setFileData(null);
    (async () => {
      try {
        const fd = await api.readFile(data.root, rel);
        if (myReq !== reqRef.current) return;
        setFileData(fd);
      } catch (e) {
        if (myReq !== reqRef.current) return;
        setError(e instanceof Error ? e.message : "Failed to read file");
      } finally {
        if (myReq === reqRef.current) setLoading(false);
      }
    })();
  }, [data.root, rel]);

  if (loading) {
    return (
      <div role="status" aria-live="polite" className="flex h-full items-center justify-center text-muted">
        <Spinner /> <span className="ml-2">Loading file…</span>
      </div>
    );
  }
  if (error) return <p className="px-8 py-8 text-sm text-danger">{error}</p>;
  if (!fileData) return null;
  return <FilePane key={fileData.rel} root={data.root} file={fileData} onSaved={() => afterSave(rel)} />;
}
