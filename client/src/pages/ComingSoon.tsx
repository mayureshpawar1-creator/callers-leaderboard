import { SECTIONS, type Section } from "../components/Layout";

export function ComingSoon({ section }: { section: Section }) {
  const s = SECTIONS.find((x) => x.id === section);
  return (
    <div className="card max-w-xl">
      <h1 className="text-lg font-semibold">{s?.label ?? "Not found"}</h1>
      <p className="mt-2 text-sm text-slate-600">
        {s ? `This section is scheduled for Phase ${s.phase} and is not built yet.` : "This page does not exist."}
      </p>
    </div>
  );
}
