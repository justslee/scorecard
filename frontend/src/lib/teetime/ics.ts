/**
 * ICS (RFC 5545) generation for a booked/held tee time — zero dependencies.
 *
 * `buildTeeTimeICS` is a pure function (unit-tested); `downloadICS` is the
 * thin browser shim that hands the file to the OS calendar. The single event
 * carries a VALARM so "Add to calendar" covers "Set reminder" too.
 */

export interface TeeTimeCalendarEvent {
  courseName: string;
  /** City / address label, used for LOCATION. */
  city?: string;
  /** ISO 8601 date (YYYY-MM-DD). */
  date: string;
  /** 24-h "HH:MM". */
  time: string;
  partySize: number;
  /** Course booking page — included in the description when present. */
  bookingUrl?: string | null;
  /** True when the time is an estimated window, not a confirmed slot. */
  estimated?: boolean;
  /** Event length; a golf round blocks the morning. Default 240 min. */
  durationMinutes?: number;
}

/** Escape text per RFC 5545 §3.3.11 (backslash, semicolon, comma, newline). */
export function escapeICSText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/** Fold a content line at 74 chars (continuations begin with a space) — RFC 5545 §3.1. */
export function foldICSLine(line: string): string {
  if (line.length <= 74) return line;
  const parts: string[] = [line.slice(0, 74)];
  for (let i = 74; i < line.length; i += 73) {
    parts.push(" " + line.slice(i, i + 73));
  }
  return parts.join("\r\n");
}

/** "2026-10-18" + "06:30" (+ offset minutes) → floating local "20261018T063000". */
function icsLocalDateTime(date: string, time: string, addMinutes = 0): string {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const dt = new Date(y, mo - 1, d, h, mi + addMinutes);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}${pad(dt.getMonth() + 1)}${pad(dt.getDate())}` +
    `T${pad(dt.getHours())}${pad(dt.getMinutes())}00`;
}

/**
 * Build the full .ics document for a tee time.
 *
 * DTSTART/DTEND are floating local times — a tee time is at the course's wall
 * clock, which is where the golfer is. Includes a display VALARM 2 hours
 * before tee-off (drive + range balls).
 */
export function buildTeeTimeICS(ev: TeeTimeCalendarEvent, now: Date = new Date()): string {
  const duration = ev.durationMinutes ?? 240;
  const dtStamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const uid = `${ev.courseName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${ev.date}-${ev.time.replace(":", "")}@looper.app`;

  const summary = `Tee time — ${ev.courseName}`;
  const descriptionParts = [
    `Party of ${ev.partySize}.`,
    ...(ev.estimated ? ["Estimated window — confirm the exact time when booking."] : []),
    ...(ev.bookingUrl ? [`Book: ${ev.bookingUrl}`] : []),
  ];

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Looper//Tee Time//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${dtStamp}`,
    `DTSTART:${icsLocalDateTime(ev.date, ev.time)}`,
    `DTEND:${icsLocalDateTime(ev.date, ev.time, duration)}`,
    `SUMMARY:${escapeICSText(summary)}`,
    `DESCRIPTION:${escapeICSText(descriptionParts.join("\n"))}`,
    ...(ev.city ? [`LOCATION:${escapeICSText(`${ev.courseName}, ${ev.city}`)}`] : [`LOCATION:${escapeICSText(ev.courseName)}`]),
    ...(ev.bookingUrl ? [`URL:${ev.bookingUrl}`] : []),
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    "TRIGGER:-PT2H",
    `DESCRIPTION:${escapeICSText(`Tee time at ${ev.courseName} in 2 hours`)}`,
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ];

  return lines.map(foldICSLine).join("\r\n") + "\r\n";
}

/** A tidy filename: "tee-time-presidio-2026-10-18.ics". */
export function icsFilename(ev: Pick<TeeTimeCalendarEvent, "courseName" | "date">): string {
  const slug = ev.courseName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `tee-time-${slug}-${ev.date}.ics`;
}

/** Browser-only: hand the ICS to the OS as a downloadable calendar file. */
export function downloadICS(ics: string, filename: string): void {
  const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
