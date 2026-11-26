import { describe, expect, it } from "vitest";
import {
  normalizeCallNumber, parseAttempts, parseCdrDate, parseCdrDateTime, parseDuration,
} from "../src/cdr/normalize.js";

describe("parseCdrDate", () => {
  it("parses DD/MM/YYYY day-first (never month-first)", () => {
    expect(parseCdrDate("16/11/2026")).toBe("2026-11-16");
    expect(parseCdrDate("01/02/2026")).toBe("2026-02-01"); // 1 Feb, not 2 Jan
    expect(parseCdrDate("1/2/2026")).toBe("2026-02-01");
    expect(parseCdrDate("16-11-2026")).toBe("2026-11-16");
    expect(parseCdrDate("16.11.2026")).toBe("2026-11-16");
  });
  it("parses ISO and DD-Mon-YYYY", () => {
    expect(parseCdrDate("2026-11-16")).toBe("2026-11-16");
    expect(parseCdrDate("2026-11-16 00:00:00")).toBe("2026-11-16");
    expect(parseCdrDate("23-Nov-2026")).toBe("2026-11-23");
  });
  it("rejects impossible or month-first dates", () => {
    expect(parseCdrDate("11/16/2026")).toBeNull(); // month 16
    expect(parseCdrDate("31/02/2026")).toBeNull();
    expect(parseCdrDate("29/02/2026")).toBeNull(); // 2026 is not a leap year
    expect(parseCdrDate("29/02/2028")).toBe("2028-02-29");
    expect(parseCdrDate("")).toBeNull();
    expect(parseCdrDate(null)).toBeNull();
    expect(parseCdrDate("yesterday")).toBeNull();
  });
  it("handles Excel serials and Date cells by calendar fields", () => {
    expect(parseCdrDate(46342)).toBe("2026-11-16");
    expect(parseCdrDate(new Date(Date.UTC(2026, 10, 16)))).toBe("2026-11-16");
  });
});

describe("parseCdrDateTime", () => {
  it("keeps IST wall-clock values unchanged", () => {
    expect(parseCdrDateTime("16/11/2026 12:16")).toBe("2026-11-16 12:16:00");
    expect(parseCdrDateTime("2026-11-21 13:36:59")).toBe("2026-11-21 13:36:59");
    expect(parseCdrDateTime("23-Nov-2026 13:55:44")).toBe("2026-11-23 13:55:44");
  });
  it("rejects invalid times", () => {
    expect(parseCdrDateTime("16/11/2026 25:00")).toBeNull();
    expect(parseCdrDateTime("16/11/2026")).toBeNull();
  });
});

describe("parseDuration (TALK_DURATION)", () => {
  it("converts HH:MM:SS to integer seconds", () => {
    expect(parseDuration("00:02:06").seconds).toBe(126);
    expect(parseDuration("02:30:00").seconds).toBe(9000);
    expect(parseDuration("00:00:00").seconds).toBe(0);
    expect(parseDuration("26:00:01").seconds).toBe(93601); // hours may exceed 24
    expect(parseDuration("2:04:57").seconds).toBe(7497);
  });
  it("floors fractional seconds and flags non-zero fractions", () => {
    expect(parseDuration("00:00:00.000000")).toEqual({ seconds: 0, hadFraction: false, fromExcelTime: false });
    expect(parseDuration("00:00:10.900")).toEqual({ seconds: 10, hadFraction: true, fromExcelTime: false });
  });
  it("rejects ambiguous or malformed values", () => {
    expect(parseDuration("02:06").seconds).toBeNull(); // MM:SS vs HH:MM is ambiguous
    expect(parseDuration("00:61:00").seconds).toBeNull();
    expect(parseDuration("abc").seconds).toBeNull();
    expect(parseDuration("").seconds).toBeNull();
    expect(parseDuration(null).seconds).toBeNull();
    expect(parseDuration(-0.1).seconds).toBeNull();
  });
  it("interprets numeric cells as Excel time and flags it", () => {
    expect(parseDuration(9000 / 86400)).toEqual({ seconds: 9000, hadFraction: false, fromExcelTime: true });
  });
});

describe("normalizeCallNumber", () => {
  it("normalises numeric and decimal-string call numbers identically", () => {
    expect(normalizeCallNumber(38724663)).toBe("38724663");
    expect(normalizeCallNumber("38724663.0")).toBe("38724663");
    expect(normalizeCallNumber(" 38724663 ")).toBe("38724663");
    expect(normalizeCallNumber("")).toBeNull();
    expect(normalizeCallNumber(null)).toBeNull();
  });
});

describe("parseAttempts", () => {
  it("accepts non-negative whole numbers only", () => {
    expect(parseAttempts(1).value).toBe(1);
    expect(parseAttempts("1").value).toBe(1);
    expect(parseAttempts(3).value).toBe(3);
    expect(parseAttempts(1.5).error).toMatch(/whole/);
    expect(parseAttempts(-1).error).toMatch(/negative/);
    expect(parseAttempts("x").error).toMatch(/not a number/);
    expect(parseAttempts(null).error).toMatch(/empty/);
  });
});
