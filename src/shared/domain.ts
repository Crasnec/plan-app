// Date-only arithmetic is deliberately independent of the machine's timezone.
export const DAY = 86400000;
export const KST = 9 * 3600000;
export type Kind = "undated" | "all_day" | "timed";
export type Scope = "one" | "future" | "all";
export interface Rule {
  frequency: "daily" | "weekly" | "monthly";
  interval: number;
  weekdays: number[];
  monthly: "date" | "last_day" | "nth_weekday";
  day: number;
  ordinal: number;
  weekday: number;
  until: string | null;
}
export interface Fields {
  title: string;
  notes: string;
  kind: Kind;
  start: string | null;
  end: string | null;
  public: boolean;
  done: boolean;
  reminder: number | null;
  rule: Rule | null;
}
export interface Item extends Fields {
  id: string;
  version: number;
  deletedAt: string | null;
  cutoff: string | null;
}
export interface Override {
  itemId: string;
  key: string;
  patch: Partial<Fields>;
  deletedAt: string | null;
}
export interface Occurrence extends Fields {
  id: string;
  itemId: string;
  key: string;
  version: number;
  recurring: boolean;
  seriesStart: string | null;
}
export const dateMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
export const addDays = (d: string, n: number) =>
  new Date(dateMs(d) + n * DAY).toISOString().slice(0, 10);
export const dateDiff = (a: string, b: string) =>
  Math.round((dateMs(a) - dateMs(b)) / DAY);
export const weekday = (d: string) => (new Date(dateMs(d)).getUTCDay() + 6) % 7;
export const today = () =>
  new Date(Date.now() + KST).toISOString().slice(0, 10);
export const local = (utc: string) =>
  new Date(Date.parse(utc) + KST).toISOString().slice(0, 16);
export const toUTC = (s: string) => new Date(`${s}+09:00`).toISOString();
export const startDate = (f: Pick<Fields, "kind" | "start">) =>
  f.start ? (f.kind === "timed" ? local(f.start).slice(0, 10) : f.start) : null;
export const endDate = (f: Pick<Fields, "kind" | "end">) =>
  f.end
    ? f.kind === "timed"
      ? new Date(Date.parse(f.end) - 1 + KST).toISOString().slice(0, 10)
      : addDays(f.end, -1)
    : null;
export function monthDays(d: string) {
  const [y, m] = d.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
export function matches(anchor: string, d: string, r: Rule): boolean {
  if (d < anchor || (r.until && d > r.until)) return false;
  if (r.frequency === "daily") return dateDiff(d, anchor) % r.interval === 0;
  if (r.frequency === "weekly") {
    const weeks =
      dateDiff(addDays(d, -weekday(d)), addDays(anchor, -weekday(anchor))) / 7;
    return weeks % r.interval === 0 && r.weekdays.includes(weekday(d));
  }
  const [ay, am] = anchor.split("-").map(Number),
    [y, m, day] = d.split("-").map(Number);
  if (((y - ay) * 12 + m - am) % r.interval !== 0) return false;
  if (r.monthly === "last_day") return day === monthDays(d);
  if (r.monthly === "date") return day === r.day;
  return (
    weekday(d) === r.weekday &&
    (r.ordinal === -1
      ? day + 7 > monthDays(d)
      : Math.floor((day - 1) / 7) + 1 === r.ordinal)
  );
}
export function atDate(item: Item, key: string): Occurrence {
  const anchor = startDate(item);
  const delta = anchor && key !== "single" ? dateDiff(key, anchor) : 0;
  return {
    ...item,
    id: `${item.id}:${key}`,
    itemId: item.id,
    key,
    recurring: !!item.rule,
    seriesStart: item.start,
    start: item.start
      ? item.kind === "timed"
        ? new Date(Date.parse(item.start) + delta * DAY).toISOString()
        : addDays(item.start, delta)
      : null,
    end: item.end
      ? item.kind === "timed"
        ? new Date(Date.parse(item.end) + delta * DAY).toISOString()
        : addDays(item.end, delta)
      : null,
  };
}
export function validKey(item: Item, key: string): boolean {
  if (!item.rule) return key === "single";
  return (
    validDate(key) &&
    !!startDate(item) &&
    (!item.cutoff || key < item.cutoff) &&
    matches(startDate(item)!, key, item.rule)
  );
}
export function inRange(f: Fields, from: string, to: string) {
  if (f.kind === "undated") return true;
  return startDate(f)! < to && endDate(f)! >= from;
}
export function expand(
  items: Item[],
  overrides: Override[],
  from: string,
  to: string,
  publicOnly = false,
): Occurrence[] {
  const result: Occurrence[] = [];
  const map = new Map(overrides.map((o) => [`${o.itemId}:${o.key}`, o]));
  for (const item of items) {
    if (item.deletedAt) continue;
    const emit = (key: string) => {
      const override = map.get(`${item.id}:${key}`);
      if (override?.deletedAt) return;
      const occurrence = { ...atDate(item, key), ...override?.patch };
      if (inRange(occurrence, from, to) && (!publicOnly || occurrence.public))
        result.push(occurrence);
    };
    if (!item.rule) {
      emit("single");
      continue;
    }
    const anchor = startDate(item)!;
    const length = dateDiff(endDate(item)!, anchor) + 1;
    const scanStart = addDays(from, -length);
    const processed = new Set<string>();
    for (
      let d = scanStart < anchor ? anchor : scanStart;
      d < to;
      d = addDays(d, 1)
    ) {
      if (validKey(item, d)) {
        emit(d);
        processed.add(d);
      }
    }
    // An exception can be moved into this window from outside it.
    for (const o of overrides)
      if (
        o.itemId === item.id &&
        !processed.has(o.key) &&
        validKey(item, o.key)
      )
        emit(o.key);
  }
  return result.sort(
    (a, b) =>
      (a.start ?? "z").localeCompare(b.start ?? "z") ||
      a.title.localeCompare(b.title),
  );
}
export function validDate(v: unknown): v is string {
  return (
    typeof v === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(v) &&
    v >= "1970-01-01" &&
    v <= "2200-12-31" &&
    Number.isFinite(dateMs(v)) &&
    new Date(dateMs(v)).toISOString().slice(0, 10) === v
  );
}
export function validate(input: unknown): Fields {
  if (!input || typeof input !== "object")
    throw new Error("일정 내용을 확인해 주세요.");
  const x = input as Fields;
  if (typeof x.title !== "string" || !x.title.trim() || x.title.length > 200)
    throw new Error("제목은 1~200자로 입력해 주세요.");
  if (typeof x.notes !== "string" || x.notes.length > 10000)
    throw new Error("메모는 10,000자 이내로 입력해 주세요.");
  if (
    !["undated", "all_day", "timed"].includes(x.kind) ||
    typeof x.public !== "boolean" ||
    typeof x.done !== "boolean"
  )
    throw new Error("일정 형식이 올바르지 않습니다.");
  if (
    x.reminder !== null &&
    (!Number.isInteger(x.reminder) || x.reminder < -1439 || x.reminder > 10080)
  )
    throw new Error("알림 시간을 확인해 주세요.");
  if (x.kind === "undated") {
    if (
      x.start !== null ||
      x.end !== null ||
      x.rule !== null ||
      x.reminder !== null
    )
      throw new Error("날짜 미정에는 날짜·반복·알림을 설정할 수 없습니다.");
  } else {
    const isTime = (v: unknown): v is string =>
      typeof v === "string" &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) &&
      Number.isFinite(Date.parse(v)) &&
      new Date(v).toISOString() === v &&
      validDate(local(v).slice(0, 10));
    if (
      x.kind === "all_day"
        ? !validDate(x.start) || !validDate(x.end)
        : !isTime(x.start) || !isTime(x.end)
    )
      throw new Error("시작과 종료를 정확히 입력해 주세요.");
    if (
      x.start! >= x.end! ||
      (x.kind === "timed"
        ? Date.parse(x.end!) - Date.parse(x.start!)
        : dateMs(x.end!) - dateMs(x.start!)) >
        366 * DAY
    )
      throw new Error("종료는 시작 이후, 기간은 366일 이내로 지정해 주세요.");
  }
  let rule: Rule | null = null;
  if (x.rule !== null) {
    const r = x.rule;
    if (
      !r ||
      !["daily", "weekly", "monthly"].includes(r.frequency) ||
      !Number.isInteger(r.interval) ||
      r.interval < 1 ||
      r.interval > 99 ||
      !Array.isArray(r.weekdays) ||
      !r.weekdays.every((w) => Number.isInteger(w) && w >= 0 && w <= 6) ||
      (r.frequency === "weekly" && !r.weekdays.length) ||
      !["date", "last_day", "nth_weekday"].includes(r.monthly) ||
      !Number.isInteger(r.day) ||
      r.day < 1 ||
      r.day > 31 ||
      ![-1, 1, 2, 3, 4, 5].includes(r.ordinal) ||
      !Number.isInteger(r.weekday) ||
      r.weekday < 0 ||
      r.weekday > 6 ||
      (r.until !== null && (!validDate(r.until) || r.until < startDate(x)!))
    )
      throw new Error("반복 조건을 확인해 주세요.");
    rule = {
      frequency: r.frequency,
      interval: r.interval,
      weekdays: [...new Set(r.weekdays)],
      monthly: r.monthly,
      day: r.day,
      ordinal: r.ordinal,
      weekday: r.weekday,
      until: r.until,
    };
  }
  return {
    title: x.title.trim(),
    notes: x.notes,
    kind: x.kind,
    start: x.start,
    end: x.end,
    public: x.public,
    done: x.done,
    reminder: x.reminder,
    rule,
  };
}
export function defaultFields(date: string | null = today()): Fields {
  return {
    title: "",
    notes: "",
    kind: date ? "all_day" : "undated",
    start: date,
    end: date ? addDays(date, 1) : null,
    done: false,
    public: false,
    reminder: date ? -540 : null,
    rule: null,
  };
}
export function reminderAt(f: Fields): number | null {
  if (f.kind === "undated" || f.reminder === null || f.done) return null;
  return (
    (f.kind === "timed" ? Date.parse(f.start!) : dateMs(f.start!) - KST) -
    f.reminder * 60000
  );
}
