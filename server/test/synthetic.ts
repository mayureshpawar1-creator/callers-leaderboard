// Deterministic synthetic CDR workbook with the same structure as the dialer export:
// sheet "data", metadata rows above the header, header on row 9, 33 columns (including both
// "DISPOSITION" and "disposition"), DD/MM/YYYY dates and HH:MM:SS durations. All people are fictional.
import ExcelJS from "exceljs";

export const SYN_HEADERS = [
  "DATE", "CALL_NUMBER", "Attempts", "SERVICE_NAME", "AGENT_ID", "AGENT_NAME", "CALL_START_TIME", "CALL_END_TIME",
  "AGENT TERMINAL", "CALL_SERVICE_DNI", "CALL_DESTINATION", "CALLTYPE", "DISPOSITION", "callback_date", "disposition",
  "sub_disposition", "sub_sub_disposition", "LEAD_REF_ID", "DP_OCCUPATION", "Customer_link_click_reason", "current_occupation",
  "pincode", "c_redirected_from", "BATCH_NAME", "HangupCode", "HANGUPBY", "CALL_DURATION", "QueueDuration", "RING_DURATION",
  "TALK_DURATION", "WRAPUP_DURATION", "HOLD_DURATION", "Remarks",
];

export const SYN_AGENTS = [
  { id: "SYN0001", name: "Caller Alpha" },
  { id: "SYN0002", name: "Caller Bravo" },
  { id: "SYN0003", name: "Caller Charlie" },
];
export const SYN_DAYS = ["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20", "2026-11-21"];

/** Calls per agent per day. Alpha reaches 300 attempts on Mon and Tue; Charlie has no calls on Wednesday. */
const PLAN: Record<string, number[]> = { SYN0001: [300, 310, 120, 90, 80, 40], SYN0002: [150, 140, 160, 130, 120, 60], SYN0003: [70, 60, 0, 55, 65, 30] };

const hms = (s: number) => [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, "0")).join(":");
const dmy = (ymd: string) => `${ymd.slice(8)}/${ymd.slice(5, 7)}/${ymd.slice(0, 4)}`;

export interface SyntheticTruth {
  rows: number;
  /** "AGENT|YYYY-MM-DD" -> [attempts, talkSeconds], computed by the generator, not the app. */
  agentDays: Record<string, [number, number]>;
  totalAttempts: number;
  totalTalkSeconds: number;
}

export async function syntheticCdrXlsx(): Promise<{ buffer: Buffer; truth: SyntheticTruth }> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("data");
  ws.getRow(1).values = ["CDR_Mask_Report"];
  ws.getRow(3).values = ["From : ", "2026-11-16 00:00:00"];
  ws.getRow(4).values = ["To : ", "2026-11-21 13:30:00"]; // last day only partly covered
  ws.getRow(5).values = ["Format : ", "excel"];
  ws.getRow(6).values = ["ReportDate : ", "23-Nov-2026 10:00:00"];
  ws.getRow(9).values = SYN_HEADERS;

  const truth: SyntheticTruth = { rows: 0, agentDays: {}, totalAttempts: 0, totalTalkSeconds: 0 };
  let callNo = 50_000_000;
  let r = 10;
  SYN_DAYS.forEach((day, di) => {
    for (const a of SYN_AGENTS) {
      const n = PLAN[a.id]![di]!;
      for (let i = 0; i < n; i++) {
        // Alpha talks exactly 2h30m on Monday (9,000 s over 300 calls = 30 s each); otherwise a deterministic pattern.
        const talk = a.id === "SYN0001" && di === 0 ? 30 : (i * 37 + di * 11 + a.id.charCodeAt(6) * 3) % 95;
        const call = talk + 20 + (i % 7);
        const startMin = 600 + Math.floor((i * 480) / Math.max(n, 1));
        const start = `${dmy(day)} ${String(Math.floor(startMin / 60)).padStart(2, "0")}:${String(startMin % 60).padStart(2, "0")}`;
        const values: Record<string, string | number> = {
          DATE: dmy(day), CALL_NUMBER: callNo++, Attempts: 1, SERVICE_NAME: "Quote_Conversion", AGENT_ID: a.id, AGENT_NAME: a.name,
          CALL_START_TIME: start, CALL_END_TIME: start, CALL_DESTINATION: "XXXXXX0000", CALLTYPE: "Manual",
          DISPOSITION: talk > 0 ? "Contactable" : "NonContactable", disposition: talk > 0 ? "Contactable" : "NonContactable",
          LEAD_REF_ID: `SYN${callNo}`, CALL_DURATION: hms(call), TALK_DURATION: hms(talk), WRAPUP_DURATION: "00:00:10",
          HOLD_DURATION: "00:00:00.000000", Remarks: "synthetic",
        };
        ws.getRow(r++).values = SYN_HEADERS.map((h) => values[h] ?? "");
        const key = `${a.id}|${day}`;
        const cur = truth.agentDays[key] ?? [0, 0];
        truth.agentDays[key] = [cur[0] + 1, cur[1] + talk];
        truth.rows++;
        truth.totalAttempts++;
        truth.totalTalkSeconds += talk;
      }
    }
  });
  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), truth };
}
