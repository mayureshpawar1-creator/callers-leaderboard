import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { CdrParseError, parseCdrFile } from "../src/cdr/parser.js";
import { csvFile } from "./helpers.js";
import { SYN_HEADERS, syntheticCdrXlsx } from "./synthetic.js";

describe("parseCdrFile on a dialer-format workbook (synthetic)", () => {
  it("detects sheet, header row 9, 33 columns, metadata and record count", async () => {
    const { buffer, truth } = await syntheticCdrXlsx();
    const s = await parseCdrFile(buffer, "synthetic.xlsx");
    expect(s.sheetName).toBe("data");
    expect(s.headerRow).toBe(9);
    expect(s.headers).toHaveLength(SYN_HEADERS.length);
    expect(s.rows).toHaveLength(truth.rows);
    expect(s.rows[0]!.rowNumber).toBe(10);
    expect(s.reportFrom).toBe("2026-11-16 00:00:00");
    expect(s.reportTo).toBe("2026-11-21 13:30:00");
    expect(s.reportGeneratedAt).toBe("2026-11-23 10:00:00");
  });

  it("maps DISPOSITION exactly although a lowercase 'disposition' column also exists; TALK_DURATION is not CALL_DURATION", async () => {
    const s = await parseCdrFile((await syntheticCdrXlsx()).buffer, "x.xlsx");
    expect(s.headers[s.columnIndex.DISPOSITION!]).toBe("DISPOSITION");
    expect(s.headers).toContain("disposition");
    expect(s.headers[s.columnIndex.TALK_DURATION!]).toBe("TALK_DURATION");
  });
});

describe("dynamic header detection", () => {
  it("finds the header at a different row in CSV", async () => {
    const s = await parseCdrFile(csvFile([{ callNumber: "1" }], "a\nb\nc\n\n\nFrom : ,2026-11-16 00:00:00\nTo : ,2026-11-21 23:59:59\nx\ny\nz\n"), "r.csv");
    expect(s.headerRow).toBe(11); // 10 metadata/blank lines above the header
    expect(s.rows).toHaveLength(1);
  });

  it("finds the header on row 1 with no metadata and warns about unknown coverage", async () => {
    const s = await parseCdrFile(csvFile([{ callNumber: "1" }], ""), "r.csv");
    expect(s.headerRow).toBe(1);
    expect(s.reportFrom).toBeNull();
    expect(s.headerWarnings.join(" ")).toMatch(/coverage cannot be verified/);
  });

  it("prefers the 'data' sheet and skips sheets without a CDR header", async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("Summary").addRow(["Total", 5]);
    const ws = wb.addWorksheet("data");
    ws.addRow(["DATE", "CALL_NUMBER", "Attempts", "AGENT_ID", "AGENT_NAME", "TALK_DURATION"]);
    ws.addRow(["16/11/2026", 1, 1, "A", "Alpha", "00:01:00"]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const s = await parseCdrFile(buf, "t.xlsx");
    expect(s.sheetName).toBe("data");
    expect(s.headerRow).toBe(1);
    expect(s.headerWarnings.some((w) => w.includes("CALL_START_TIME"))).toBe(true);
  });

  it("fails clearly when a required column is missing", async () => {
    const buf = Buffer.from("DATE,CALL_NUMBER,Attempts,AGENT_ID,AGENT_NAME,CALL_DURATION\n16/11/2026,1,1,A,B,00:01:00\n");
    await expect(parseCdrFile(buf, "t.csv")).rejects.toThrow(CdrParseError);
    await expect(parseCdrFile(buf, "t.csv")).rejects.toThrow(/missing: TALK_DURATION/);
  });

  it("rejects unsupported formats", async () => {
    await expect(parseCdrFile(Buffer.from("x"), "t.xls")).rejects.toThrow(/xls format is not supported/);
    await expect(parseCdrFile(Buffer.from("x"), "t.pdf")).rejects.toThrow(/Unsupported file type/);
  });
});
