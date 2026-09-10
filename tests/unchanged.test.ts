import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultFields,
  sameFields,
  sameSchedule,
} from "../src/shared/domain.js";
test("Unchanged schedules compare instants and unchanged fields ignore metadata", () => {
  const a = { ...defaultFields("2026-09-10"), title: "일정" };
  assert(sameFields(a, { ...a }));
  assert(!sameFields(a, { ...a, notes: "변경" }));
  assert(!sameFields(a, { ...a, done: !a.done }));
  assert(!sameSchedule(a, { ...a, end: "2026-09-12" }));
  const timed = {
    ...a,
    kind: "timed" as const,
    start: "2026-09-10T01:00:00.000Z",
    end: "2026-09-10T02:00:00.000Z",
  };
  assert(
    sameSchedule(timed, {
      ...timed,
      start: "2026-09-10T10:00:00+09:00",
      end: "2026-09-10T02:00:00Z",
    }),
  );
  assert(!sameSchedule(timed, { ...timed, end: "2026-09-10T02:30:00Z" }));
});
