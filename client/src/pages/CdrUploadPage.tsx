import { useEffect, useRef, useState } from "react";
import type { ImportSummary } from "../../../shared/types";
import { api } from "../api";
import { fmtInt, fmtTimestamp } from "../format";
import { StatusBadge } from "../components/StatusBadge";

export function CdrUploadPage({ navigate }: { navigate: (p: string) => void }) {
  const [imports, setImports] = useState<ImportSummary[] | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.get<ImportSummary[]>("/api/cdr/imports").then(setImports).catch((e: Error) => setError(e.message));
  }, []);

  async function upload() {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const { importId } = await api.upload<{ importId: number }>("/api/cdr/imports", file);
      navigate(`cdr/${importId}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">CDR Upload</h1>
        <p className="text-sm text-slate-600">
          Upload a daily or weekly CDR report (.xlsx or .csv). You will see a preview and must confirm before anything is saved.
          Re-uploading a report never double-counts calls.
        </p>
      </div>

      <div className="card flex flex-wrap items-center gap-3">
        <input
          ref={inputRef}
          type="file"
          accept=".xlsx,.csv"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="text-sm file:mr-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-sm"
        />
        <button className="btn-primary" disabled={!file || busy} onClick={upload}>
          {busy ? "Reading file…" : "Upload & preview"}
        </button>
        {error && <div className="w-full rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      </div>

      <div className="card overflow-x-auto p-0">
        <div className="px-4 py-3 text-sm font-semibold">Import history</div>
        <table className="w-full">
          <thead>
            <tr>
              <th className="th">#</th>
              <th className="th">File</th>
              <th className="th">Report period</th>
              <th className="th">Status</th>
              <th className="th num">Rows</th>
              <th className="th num">New</th>
              <th className="th num">Duplicates</th>
              <th className="th num">Conflicts</th>
              <th className="th num">Invalid</th>
              <th className="th">Uploaded</th>
            </tr>
          </thead>
          <tbody>
            {imports?.length === 0 && (
              <tr><td className="td text-slate-500" colSpan={10}>No reports uploaded yet.</td></tr>
            )}
            {imports?.map((i) => (
              <tr key={i.id} className="cursor-pointer hover:bg-slate-50" onClick={() => navigate(`cdr/${i.id}`)}>
                <td className="td">{i.id}</td>
                <td className="td max-w-72 truncate" title={i.fileName}>{i.fileName}</td>
                <td className="td text-xs">{i.reportFrom ?? "?"} → {i.reportTo ?? "?"}</td>
                <td className="td"><StatusBadge status={i.status} /></td>
                <td className="td num">{fmtInt(i.totalRows)}</td>
                <td className="td num">{fmtInt(i.counts.new)}</td>
                <td className="td num">{fmtInt(i.counts.duplicate_existing + i.counts.duplicate_in_file)}</td>
                <td className="td num">{fmtInt(i.counts.conflict_existing + i.counts.conflict_in_file)}</td>
                <td className="td num">{fmtInt(i.counts.invalid)}</td>
                <td className="td text-xs">{fmtTimestamp(i.uploadedAt)} · {i.uploadedBy}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
