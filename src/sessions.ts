/** Regular session, in minutes after midnight New York time. */
const REGULAR_OPEN = 9 * 60 + 30;
const REGULAR_CLOSE = 16 * 60;

const nyClock = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

/** The last two regular-session closes (4 PM New York): the latest and the one before. */
export function dailyCloses(bars: { t: string; c: number }[]): { lastClose: number | null; prevClose: number | null } {
  const closes: { day: string; close: number }[] = [];
  // Walk back from the end; only a few days are needed.
  for (let i = bars.length - 1; i >= 0 && closes.length < 3; i--) {
    const p = Object.fromEntries(nyClock.formatToParts(new Date(bars[i]!.t)).map((x) => [x.type, x.value]));
    const minutes = Number(p.hour) * 60 + Number(p.minute);
    if (minutes < REGULAR_OPEN || minutes >= REGULAR_CLOSE) continue;
    const day = `${p.year}-${p.month}-${p.day}`;
    if (closes.at(-1)?.day !== day) closes.push({ day, close: bars[i]!.c });
  }
  return { lastClose: closes[0]?.close ?? null, prevClose: closes[1]?.close ?? null };
}
