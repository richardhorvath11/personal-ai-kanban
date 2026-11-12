// Deterministic date handling in the user's configured time zone.
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

export function todayIn(tz: string, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
const toUtc = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
export const addDays = (d: string, n: number) => new Date(toUtc(d) + n * 86400_000).toISOString().slice(0, 10);
const dow = (d: string) => new Date(toUtc(d)).getUTCDay();
export const weekdayName = (d: string) => WEEKDAYS[dow(d)][0].toUpperCase() + WEEKDAYS[dow(d)].slice(1, 3);

/** Offset like "-06:00" for tz at the given UTC instant. */
function offsetFor(tz: string, at: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(at);
  const v = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const m = /GMT([+-]\d{2}:\d{2})?/.exec(v);
  return m?.[1] ?? '+00:00';
}

/** Days from today (in tz) until a deadline. Date-only deadlines compare calendar dates. */
export function daysUntil(deadline: string, tz: string, now = new Date()): number {
  if (deadline.length === 10) return Math.round((toUtc(deadline) - toUtc(todayIn(tz, now))) / 86400_000);
  return Math.floor((new Date(deadline).getTime() - now.getTime()) / 86400_000);
}
export const isPast = (deadline: string, tz: string, now = new Date()) =>
  deadline.length === 10 ? deadline < todayIn(tz, now) : new Date(deadline).getTime() < now.getTime();

export function describeDue(deadline: string, tz: string, now = new Date()): string {
  const n = daysUntil(deadline, tz, now);
  const label = deadline.length === 10 ? `${weekdayName(deadline)} ${deadline}` : new Date(deadline).toLocaleString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  if (isPast(deadline, tz, now)) return `${label} (overdue by ${Math.max(1, -n)} day${-n === 1 ? '' : 's'})`;
  return `${label} (${n === 0 ? 'today' : n === 1 ? 'tomorrow' : `in ${n} days`})`;
}

export type Resolved = { ok: true; value: string; dateOnly: boolean; explanation: string } | { ok: false; ambiguous: true; question: string };

/** Resolve wording like "Friday", "tomorrow 3pm", "in 2 weeks", "Nov 14" to an explicit date in tz. Asks instead of guessing. */
export function resolveDate(text: string, tz: string, now = new Date()): Resolved {
  const raw = text.trim().toLowerCase().replace(/[.,]/g, ' ').replace(/\s+/g, ' ');
  const today = todayIn(tz, now);
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return { ok: true, value: raw, dateOnly: true, explanation: `explicit date ${raw}` };
  if (/^\d{4}-\d{2}-\d{2}t/.test(raw)) return { ok: true, value: new Date(text).toISOString(), dateOnly: false, explanation: 'explicit datetime' };
  // optional time-of-day suffix
  let date: string | null = null;
  let why = '';
  let rest = raw;
  const tm = /\s*(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(raw);
  let hh: number | null = null, mm = 0;
  if (tm && (tm[3] || tm[2]) && raw.length > tm[0].length) {
    hh = Number(tm[1]) % 12 + (tm[3] === 'pm' ? 12 : 0);
    if (!tm[3]) hh = Number(tm[1]);
    mm = Number(tm[2] ?? 0);
    rest = raw.slice(0, raw.length - tm[0].length).trim();
  }
  const vague = ['soon', 'later', 'sometime', 'next week', 'this weekend', 'weekend', 'asap', 'eventually', 'early next week', 'end of next week'];
  if (vague.includes(rest)) return { ok: false, ambiguous: true, question: `"${text}" is not a specific date. Which day exactly (e.g. 2026-11-20)?` };
  let m: RegExpExecArray | null;
  if (rest === 'today') { date = today; why = 'today'; }
  else if (rest === 'tomorrow') { date = addDays(today, 1); why = 'tomorrow'; }
  else if ((m = /^in (\d+) (day|days|week|weeks)$/.exec(rest))) { const n = Number(m[1]) * (m[2].startsWith('week') ? 7 : 1); date = addDays(today, n); why = `${n} days from today`; }
  else if (rest === 'end of week' || rest === 'eow' || rest === 'end of the week') { date = addDays(today, (5 - dow(today) + 7) % 7); why = 'the coming Friday'; }
  else if (rest === 'end of month' || rest === 'end of the month') { const d = new Date(toUtc(today)); date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10); why = 'last day of this month'; }
  else if ((m = /^(this |next |on )?(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)[a-z]*$/.exec(rest))) {
    const target = WEEKDAYS.findIndex((w) => w.startsWith(m![2].slice(0, 3)));
    const delta = (target - dow(today) + 7) % 7;
    if (m[1] === 'next ') return { ok: false, ambiguous: true, question: `Does "${text}" mean ${addDays(today, delta || 7)} or ${addDays(today, (delta || 7) + 7)}?` };
    if (delta === 0) return { ok: false, ambiguous: true, question: `Today is ${WEEKDAYS[target]}. Do you mean today (${today}) or ${addDays(today, 7)}?` };
    date = addDays(today, delta); why = `the coming ${WEEKDAYS[target]}`;
  } else if ((m = /^([a-z]{3,9}) (\d{1,2})$/.exec(rest)) || (m = /^(\d{1,2}) ([a-z]{3,9})$/.exec(rest))) {
    const [mon, day] = /^\d/.test(m[1]) ? [m[2], Number(m[1])] : [m[1], Number(m[2])];
    const mi = MONTHS.findIndex((x) => x.startsWith(mon.slice(0, 3)));
    if (mi >= 0 && day >= 1 && day <= 31) {
      let y = Number(today.slice(0, 4));
      let d = `${y}-${String(mi + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      if (d < today) { y++; d = `${y}-${d.slice(5)}`; }
      date = d; why = 'next occurrence of that date';
    }
  }
  if (!date) return { ok: false, ambiguous: true, question: `Couldn't turn "${text}" into a date. Please give an explicit date (YYYY-MM-DD) and, if needed, a time.` };
  if (hh === null) return { ok: true, value: date, dateOnly: true, explanation: `${why} → ${weekdayName(date)} ${date} (${tz})` };
  if (hh > 23 || mm > 59) return { ok: false, ambiguous: true, question: `"${text}" has an invalid time.` };
  const local = `${date}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`;
  const off = offsetFor(tz, new Date(`${local}Z`));
  return { ok: true, value: `${local}${off}`, dateOnly: false, explanation: `${why} at ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')} ${tz}` };
}
