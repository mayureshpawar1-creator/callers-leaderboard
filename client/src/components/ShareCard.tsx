import { useEffect, useRef } from "react";
import type { CotwPublication } from "../../../shared/types";

export interface ShareOptions {
  headline: string;
  message: string;
  showScores: boolean;
}

const W = 1080;
const H = 1350;
const MEDAL = [
  { ring: "#f5c542", fill: "#fde68a", text: "#78350f", label: "RANK 1" },
  { ring: "#cbd5e1", fill: "#f1f5f9", text: "#334155", label: "RANK 2" },
  { ring: "#d6955b", fill: "#fed7aa", text: "#7c2d12", label: "RANK 3" },
];
const FONT = "Inter, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export function fmtRewardDate(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" })
    .format(new Date(Date.UTC(y!, m! - 1, d!)));
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/)) {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width > maxWidth && line) {
        lines.push(line);
        line = word;
      } else line = test;
    }
    lines.push(line);
  }
  return lines;
}

function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, size: number, weight = 700): number {
  let s = size;
  do {
    ctx.font = `${weight} ${s}px ${FONT}`;
    if (ctx.measureText(text).width <= maxWidth) break;
    s -= 2;
  } while (s > 20);
  return s;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function drawCard(canvas: HTMLCanvasElement, pub: CotwPublication, opt: ShareOptions) {
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, "#1e1b4b");
  bg.addColorStop(1, "#4338ca");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // Soft decorative circles
  ctx.globalAlpha = 0.08;
  ctx.fillStyle = "#ffffff";
  ctx.beginPath(); ctx.arc(980, 120, 260, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(80, 1250, 220, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = 1;

  ctx.textAlign = "center";
  ctx.fillStyle = "#fcd34d";
  ctx.font = `700 34px ${FONT}`;
  ctx.fillText("★  CALLER OF THE WEEK  ★", W / 2, 120);
  ctx.fillStyle = "#ffffff";
  fitText(ctx, opt.headline, W - 160, 64, 800);
  ctx.fillText(opt.headline, W / 2, 205);
  ctx.fillStyle = "#c7d2fe";
  ctx.font = `500 32px ${FONT}`;
  ctx.fillText(pub.weekLabel, W / 2, 260);

  // Winners (rank <= 3, ties may add names)
  const winners = pub.ranking.filter((r) => r.rank <= 3).slice(0, 5);
  const top = 320;
  const gap = 24;
  const cardH = winners.length <= 3 ? 205 : 160;
  winners.forEach((w, i) => {
    const y = top + i * (cardH + gap);
    const m = MEDAL[Math.min(w.rank, 3) - 1]!;
    const first = w.rank === 1;
    ctx.fillStyle = first ? "rgba(253, 230, 138, 0.18)" : "rgba(255, 255, 255, 0.10)";
    roundRect(ctx, 80, y, W - 160, cardH, 28);
    ctx.fill();
    if (first) { ctx.strokeStyle = "#fcd34d"; ctx.lineWidth = 4; ctx.stroke(); }

    // Medal
    const cx = 80 + 40 + cardH * 0.32, cy = y + cardH / 2, r = cardH * 0.32;
    ctx.fillStyle = m.ring;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = m.fill;
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.8, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = m.text;
    ctx.font = `800 ${Math.round(r * 0.95)}px ${FONT}`;
    ctx.textBaseline = "middle";
    ctx.fillText(String(w.rank), cx, cy + 2);
    ctx.textBaseline = "alphabetic";

    // Name + score
    ctx.textAlign = "left";
    const tx = cx + r + 40;
    const maxW = W - 80 - 40 - tx;
    ctx.fillStyle = "#fcd34d";
    ctx.font = `700 24px ${FONT}`;
    ctx.fillText(m.label, tx, cy - (opt.showScores ? 44 : 22));
    ctx.fillStyle = "#ffffff";
    fitText(ctx, w.displayName, maxW, first ? 54 : 46, 800);
    ctx.fillText(w.displayName, tx, cy + (opt.showScores ? 14 : 30));
    if (opt.showScores) {
      ctx.fillStyle = "#e0e7ff";
      ctx.font = `600 30px ${FONT}`;
      ctx.fillText(`${w.totalMarks.toFixed(2)} / 100`, tx, cy + 62);
    }
    ctx.textAlign = "center";
  });

  // Footer message
  const footTop = top + winners.length * (cardH + gap) + 30;
  ctx.fillStyle = "#ffffff";
  ctx.font = `500 32px ${FONT}`;
  const lines = wrap(ctx, opt.message, W - 200);
  lines.slice(0, 6).forEach((l, i) => ctx.fillText(l, W / 2, footTop + 20 + i * 46));

  ctx.fillStyle = "#a5b4fc";
  ctx.font = `500 24px ${FONT}`;
  ctx.fillText(`Published ${new Date(pub.publishedAt).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" })}`, W / 2, H - 50);
}

export function shareText(pub: CotwPublication, opt: ShareOptions): string {
  const medals = ["🥇", "🥈", "🥉"];
  const lines = [`🏆 *${opt.headline}*`, pub.weekLabel, ""];
  for (const w of pub.ranking.filter((r) => r.rank <= 3)) {
    lines.push(`${medals[w.rank - 1]} Rank ${w.rank}: *${w.displayName}*${opt.showScores ? ` (${w.totalMarks.toFixed(2)}/100)` : ""}`);
  }
  lines.push("", opt.message);
  return lines.join("\n");
}

export function ShareCard({ pub, options }: { pub: CotwPublication; options: ShareOptions }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ref.current) drawCard(ref.current, pub, options);
  }, [pub, options]);
  return <canvas ref={ref} className="h-auto w-full max-w-sm rounded-lg shadow" aria-label="Caller of the Week share card" />;
}

export function downloadCard(pub: CotwPublication, options: ShareOptions) {
  const c = document.createElement("canvas");
  drawCard(c, pub, options);
  const a = document.createElement("a");
  a.href = c.toDataURL("image/png");
  a.download = `caller-of-the-week-${pub.weekLabel.replace(/[^\w]+/g, "-").toLowerCase()}-v${pub.version}.png`;
  a.click();
}
