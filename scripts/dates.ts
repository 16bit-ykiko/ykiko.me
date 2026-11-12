export const DATE_FORMAT = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string | undefined): Intl.DateTimeFormat {
  const key = timeZone ?? "";
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(key, f);
  }
  return f;
}

function parts(
  epochMs: number,
  timeZone: string | undefined,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(new Date(epochMs))) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return out;
}

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

// "YYYY-MM-DD HH:MM:SS" of a Unix time, in the given zone (local when absent).
export function formatTimestamp(
  epochSeconds: number,
  timeZone?: string,
): string {
  const p = parts(Math.floor(epochSeconds) * 1000, timeZone);
  return `${pad(p["year"]!, 4)}-${pad(p["month"]!)}-${pad(p["day"]!)} ${pad(p["hour"]!)}:${pad(p["minute"]!)}:${pad(p["second"]!)}`;
}

// The Unix time of a "YYYY-MM-DD HH:MM:SS" wall-clock time in a zone; an
// ambiguous time takes its earlier instant.
export function parseInZone(text: string, timeZone: string): number | null {
  const m = DATE_FORMAT.exec(text);
  if (!m) return null;
  const [year, month, day, hour, minute, second] = m.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const probe = new Date(0);
  probe.setUTCFullYear(year, month - 1, day);
  probe.setUTCHours(hour, minute, second, 0);
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return null;
  }
  const asUtc = probe.getTime();
  const offsetAt = (instant: number): number => {
    const p = parts(instant, timeZone);
    const wall = Date.UTC(
      p["year"]!,
      p["month"]! - 1,
      p["day"]!,
      p["hour"]!,
      p["minute"]!,
      p["second"]!,
    );
    return wall - instant;
  };
  const candidates = new Set<number>();
  for (const guess of [
    asUtc - offsetAt(asUtc - 86400000),
    asUtc - offsetAt(asUtc + 86400000),
  ]) {
    if (asUtc - offsetAt(guess) === guess) candidates.add(guess);
  }
  if (candidates.size === 0) return (asUtc - offsetAt(asUtc)) / 1000;
  return Math.min(...candidates) / 1000;
}

// datetime.now().isoformat(timespec="seconds"), local time.
export function localIsoNow(): string {
  return formatTimestamp(Date.now() / 1000).replace(" ", "T");
}
