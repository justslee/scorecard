/**
 * Unit tests for the ICS generator — pure string output, no browser APIs.
 */

import { describe, it, expect } from "vitest";
import { buildTeeTimeICS, escapeICSText, foldICSLine, icsFilename } from "./ics";

const NOW = new Date(Date.UTC(2026, 6, 1, 12, 0, 0));

const BASE_EVENT = {
  courseName: "Presidio Golf Course",
  city: "San Francisco, CA",
  date: "2026-10-18",
  time: "06:30",
  partySize: 4,
  bookingUrl: "https://presidiogolf.com/book",
};

describe("escapeICSText", () => {
  it("escapes backslash, semicolon, comma, and newlines", () => {
    expect(escapeICSText("a;b,c\\d\ne")).toBe("a\\;b\\,c\\\\d\\ne");
  });
});

describe("foldICSLine", () => {
  it("leaves short lines alone", () => {
    expect(foldICSLine("SUMMARY:Tee time")).toBe("SUMMARY:Tee time");
  });

  it("folds long lines with a leading space on continuations", () => {
    const folded = foldICSLine("DESCRIPTION:" + "x".repeat(200));
    const lines = folded.split("\r\n");
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0].length).toBe(74);
    for (const cont of lines.slice(1)) expect(cont.startsWith(" ")).toBe(true);
    // Unfolding (strip CRLF+space) restores the original content.
    expect(folded.replace(/\r\n /g, "")).toBe("DESCRIPTION:" + "x".repeat(200));
  });
});

describe("buildTeeTimeICS", () => {
  it("produces a valid VCALENDAR/VEVENT skeleton with CRLF endings", () => {
    const ics = buildTeeTimeICS(BASE_EVENT, NOW);
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(ics).toContain("BEGIN:VEVENT");
    expect(ics).toContain("END:VEVENT");
    expect(ics).toContain("VERSION:2.0");
    expect(ics).not.toMatch(/[^\r]\n/); // every LF is part of a CRLF
  });

  it("sets DTSTART at the tee time and DTEND 4h later (floating local)", () => {
    const ics = buildTeeTimeICS(BASE_EVENT, NOW);
    expect(ics).toContain("DTSTART:20261018T063000");
    expect(ics).toContain("DTEND:20261018T103000");
  });

  it("rolls DTEND over midnight correctly", () => {
    const ics = buildTeeTimeICS({ ...BASE_EVENT, time: "22:00" }, NOW);
    expect(ics).toContain("DTSTART:20261018T220000");
    expect(ics).toContain("DTEND:20261019T020000");
  });

  it("carries course, party size, and booking URL", () => {
    const ics = buildTeeTimeICS(BASE_EVENT, NOW);
    expect(ics).toContain("SUMMARY:Tee time — Presidio Golf Course");
    expect(ics).toContain("Party of 4.");
    expect(ics.replace(/\r\n /g, "")).toContain("Book: https://presidiogolf.com/book");
    expect(ics.replace(/\r\n /g, "")).toContain("URL:https://presidiogolf.com/book");
  });

  it("includes a display VALARM 2 hours before (the reminder)", () => {
    const ics = buildTeeTimeICS(BASE_EVENT, NOW);
    expect(ics).toContain("BEGIN:VALARM");
    expect(ics).toContain("TRIGGER:-PT2H");
    expect(ics).toContain("ACTION:DISPLAY");
  });

  it("notes estimated windows in the description", () => {
    const ics = buildTeeTimeICS({ ...BASE_EVENT, estimated: true }, NOW);
    expect(ics.replace(/\r\n /g, "")).toContain("Estimated window");
  });

  it("escapes commas in LOCATION", () => {
    const ics = buildTeeTimeICS(BASE_EVENT, NOW);
    expect(ics.replace(/\r\n /g, "")).toContain(
      "LOCATION:Presidio Golf Course\\, San Francisco\\, CA"
    );
  });

  it("stamps DTSTAMP from the provided clock in UTC", () => {
    const ics = buildTeeTimeICS(BASE_EVENT, NOW);
    expect(ics).toContain("DTSTAMP:20260701T120000Z");
  });
});

describe("icsFilename", () => {
  it("slugs the course name with the date", () => {
    expect(icsFilename(BASE_EVENT)).toBe("tee-time-presidio-golf-course-2026-10-18.ics");
  });
});
