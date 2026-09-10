import { addDays, dateMs, KST, DAY, type Occurrence } from "./domain.js";
export interface Positioned {
  event: Occurrence;
  top: number;
  height: number;
  column: number;
  columns: number;
}
export function timeLayout(events: Occurrence[], date: string): Positioned[] {
  const midnight = dateMs(date) - KST;
  const list = events
    .filter(
      (e) =>
        e.kind === "timed" &&
        Date.parse(e.start!) < midnight + DAY &&
        Date.parse(e.end!) > midnight,
    )
    .map((event) => ({
      event,
      start: Math.max(0, (Date.parse(event.start!) - midnight) / 60000),
      end: Math.min(1440, (Date.parse(event.end!) - midnight) / 60000),
    }))
    .sort((a, b) => a.start - b.start || b.end - a.end);
  const result: Positioned[] = [];
  let group: Positioned[] = [],
    ends: number[] = [],
    groupEnd = -1;
  const flush = () => {
    for (const p of group) p.columns = ends.length;
    result.push(...group);
    group = [];
    ends = [];
  };
  for (const e of list) {
    if (e.start >= groupEnd) {
      flush();
      groupEnd = -1;
    }
    let column = ends.findIndex((end) => end <= e.start);
    if (column < 0) column = ends.length;
    ends[column] = e.end;
    groupEnd = Math.max(groupEnd, e.end);
    group.push({
      event: e.event,
      top: e.start,
      height: e.end - e.start,
      column,
      columns: 1,
    });
  }
  flush();
  return result;
}
