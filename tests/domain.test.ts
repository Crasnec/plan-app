import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/server/store.js";
import {
  defaultFields,
  addDays,
  toUTC,
  local,
  matches,
  validate,
  expand,
  reminderAt,
  type Rule,
  type Occurrence,
} from "../src/shared/domain.js";
import { timeLayout } from "../src/shared/layout.js";
const base: Rule = {
  frequency: "monthly",
  interval: 1,
  weekdays: [0],
  monthly: "last_day",
  day: 31,
  ordinal: -1,
  weekday: 0,
  until: null,
};
test("Converting all recurring occurrences between timed and all-day preserves earlier dates", () => {
  const s = new Store(":memory:");
  try {
    const item = s.create({
      ...defaultFields("2026-09-01"),
      title: "유형 변환",
      rule: { ...base, frequency: "daily" },
    });
    let selected = s.list("2026-09-03", "2026-09-04")[0];
    s.mutate(item.id, selected.key, selected.version, "all", {
      ...selected,
      kind: "timed",
      start: toUTC("2026-09-03T13:00"),
      end: toUTC("2026-09-03T14:00"),
      reminder: 10,
    });
    let list = s.list("2026-09-01", "2026-09-04");
    assert.equal(list.length, 3);
    assert.equal(list[0].start, toUTC("2026-09-01T13:00"));
    selected = list[2];
    s.mutate(item.id, selected.key, selected.version, "all", {
      ...selected,
      kind: "all_day",
      start: "2026-09-03",
      end: "2026-09-04",
      reminder: -540,
    });
    list = s.list("2026-09-01", "2026-09-04");
    assert.deepEqual(
      list.map((e) => e.start),
      ["2026-09-01", "2026-09-02", "2026-09-03"],
    );
    assert(list.every((e) => e.kind === "all_day"));
  } finally {
    s.db.close();
  }
});
test("editing all from a completed occurrence never marks future occurrences complete", () => {
  const s = new Store(":memory:");
  try {
    const item = s.create({
      ...defaultFields("2026-09-01"),
      title: "반복",
      rule: { ...base, frequency: "daily" },
    });
    let e = s.list("2026-09-01", "2026-09-02")[0];
    s.mutate(item.id, e.key, 1, "one", { ...e, done: true });
    e = s.list("2026-09-01", "2026-09-02")[0];
    s.mutate(item.id, e.key, 2, "all", { ...e, title: "전체 제목 수정" });
    const list = s.list("2026-09-01", "2026-09-04");
    assert.deepEqual(
      list.map((x) => x.done),
      [true, false, false],
    );
    assert(list.every((x) => x.title === "전체 제목 수정"));
  } finally {
    s.db.close();
  }
});
test("Korean input becomes UTC; UTC midnight boundary displays correctly", () => {
  assert.equal(toUTC("2026-09-10T00:30"), "2026-09-09T15:30:00.000Z");
  assert.equal(local("2026-09-09T15:30:00.000Z"), "2026-09-10T00:30");
  assert.equal(addDays("2028-02-28", 1), "2028-02-29");
});
test("explicit month-end and last Monday handle February and leap years", () => {
  assert(matches("2026-01-31", "2026-02-28", base));
  assert(matches("2026-01-31", "2028-02-29", base));
  assert(!matches("2026-01-31", "2028-02-28", base));
  const monday = { ...base, monthly: "nth_weekday" as const };
  assert(matches("2026-01-01", "2026-02-23", monday));
  assert(!matches("2026-01-01", "2026-02-16", monday));
});
test("missing fixed dates and fifth weekdays skip, not clamp", () => {
  assert(!matches("2026-01-31", "2026-02-28", { ...base, monthly: "date" }));
  for (let d = 1; d <= 28; d++)
    assert(
      !matches("2026-01-01", `2026-02-${String(d).padStart(2, "0")}`, {
        ...base,
        monthly: "nth_weekday",
        ordinal: 5,
      }),
    );
});
test("biweekly recurrence uses Monday week boundary and inclusive until", () => {
  const r = {
    ...base,
    frequency: "weekly" as const,
    interval: 2,
    weekdays: [0, 2],
    until: "2026-09-21",
  };
  assert(matches("2026-09-07", "2026-09-09", r));
  assert(!matches("2026-09-07", "2026-09-14", r));
  assert(matches("2026-09-07", "2026-09-21", r));
  assert(!matches("2026-09-07", "2026-09-23", r));
});
test("invalid dates and backwards intervals are rejected", () => {
  assert.throws(() =>
    validate({
      ...defaultFields("2026-02-28"),
      title: "잘못된 날짜",
      start: "2026-02-30",
    }),
  );
  assert.throws(() =>
    validate({
      ...defaultFields("2026-09-10"),
      title: "bad",
      end: "2026-09-10",
    }),
  );
  assert.throws(() =>
    validate({ ...defaultFields(null), title: "bad", rule: base }),
  );
});
test("multi-day events overlap ranges and all-day end is exclusive", () => {
  const s = new Store(":memory:");
  try {
    s.create({
      ...defaultFields("2026-09-01"),
      title: "여행",
      end: "2026-09-04",
    });
    assert.equal(s.list("2026-09-03", "2026-09-04").length, 1);
    assert.equal(s.list("2026-09-04", "2026-09-05").length, 0);
  } finally {
    s.db.close();
  }
});
test("moved recurrence from outside window appears once; original key remains stable", () => {
  const s = new Store(":memory:");
  try {
    const item = s.create({
      ...defaultFields("2026-09-01"),
      title: "매일",
      rule: { ...base, frequency: "daily" },
    });
    const first = s.list("2026-09-01", "2026-09-02")[0];
    s.mutate(item.id, first.key, 1, "one", {
      ...first,
      start: "2026-10-02",
      end: "2026-10-03",
    });
    const moved = s
      .list("2026-10-02", "2026-10-03")
      .find((e) => e.key === "2026-09-01");
    assert.equal(moved?.start, "2026-10-02");
    assert.equal(s.list("2026-09-01", "2026-09-02").length, 0);
  } finally {
    s.db.close();
  }
});
test("completion and public exceptions are per occurrence; stale updates conflict", () => {
  const s = new Store(":memory:");
  try {
    const i = s.create({
      ...defaultFields("2026-09-01"),
      title: "개인 반복",
      rule: { ...base, frequency: "daily" },
    });
    const e = s.list("2026-09-01", "2026-09-03")[0];
    s.mutate(i.id, e.key, 1, "one", { ...e, done: true, public: true });
    const list = s.list("2026-09-01", "2026-09-03");
    assert.equal(list[0].done, true);
    assert.equal(list[1].done, false);
    assert.equal(s.list("2026-09-01", "2026-09-03", true).length, 1);
    assert.throws(() => s.mutate(i.id, e.key, 1, "one", e), /다른 기기/);
  } finally {
    s.db.close();
  }
});
test("future edits split series; earlier completed history and later exceptions survive", () => {
  const s = new Store(":memory:");
  try {
    const i = s.create({
      ...defaultFields("2026-09-01"),
      title: "원래",
      rule: { ...base, frequency: "daily" },
    });
    let list = s.list("2026-09-01", "2026-09-06");
    s.mutate(i.id, list[0].key, 1, "one", { ...list[0], done: true });
    list = s.list("2026-09-01", "2026-09-06");
    s.mutate(i.id, list[4].key, 2, "one", { ...list[4], public: true });
    list = s.list("2026-09-01", "2026-09-06");
    s.mutate(i.id, list[2].key, 3, "future", { ...list[2], title: "새 제목" });
    list = s.list("2026-09-01", "2026-09-06");
    assert.equal(list.length, 5);
    assert.equal(list[0].done, true);
    assert.equal(list[1].title, "원래");
    assert.equal(list[2].title, "새 제목");
    assert.equal(list[4].public, true);
  } finally {
    s.db.close();
  }
});
test("all-series drag from later occurrence shifts original anchor, keeps duration", () => {
  const s = new Store(":memory:");
  try {
    const i = s.create({
      ...defaultFields("2026-09-01"),
      title: "매일",
      rule: { ...base, frequency: "daily" },
    });
    const e = s.list("2026-09-03", "2026-09-04")[0];
    s.mutate(i.id, e.key, 1, "all", {
      ...e,
      start: "2026-09-04",
      end: "2026-09-06",
    });
    assert.equal(s.item(i.id).start, "2026-09-02");
    assert.equal(s.item(i.id).end, "2026-09-04");
  } finally {
    s.db.close();
  }
});
test("structural rule changes preserve completed nonmatching history as a single item", () => {
  const s = new Store(":memory:");
  try {
    const i = s.create({
      ...defaultFields("2026-09-01"),
      title: "기록",
      rule: { ...base, frequency: "daily" },
    });
    const e = s.list("2026-09-02", "2026-09-03")[0];
    s.mutate(i.id, e.key, 1, "one", { ...e, done: true });
    const first = s.list("2026-09-01", "2026-09-02")[0];
    s.mutate(i.id, first.key, 2, "all", {
      ...first,
      rule: { ...base, frequency: "weekly", weekdays: [1] },
    });
    const history = s.list("2026-09-02", "2026-09-03");
    assert.equal(history.length, 1);
    assert.equal(history[0].done, true);
    assert.equal(history[0].recurring, false);
  } finally {
    s.db.close();
  }
});
test("one-occurrence deletion restores without reverting unrelated changes", () => {
  const s = new Store(":memory:");
  try {
    const i = s.create({
      ...defaultFields("2026-09-01"),
      title: "일정",
      rule: { ...base, frequency: "daily" },
    });
    const e = s.list("2026-09-01", "2026-09-02")[0];
    s.mutate(i.id, e.key, 1, "one", null, true);
    const other = s.list("2026-09-02", "2026-09-03")[0];
    s.mutate(i.id, other.key, 2, "one", { ...other, done: true });
    s.restore(s.trash()[0].id as string);
    assert.equal(s.list("2026-09-01", "2026-09-03").length, 2);
    assert(s.list("2026-09-02", "2026-09-03")[0].done);
  } finally {
    s.db.close();
  }
});
test("future and all deletion restore exact occurrence set", () => {
  for (const scope of ["future", "all"] as const) {
    const s = new Store(":memory:");
    try {
      const i = s.create({
        ...defaultFields("2026-09-01"),
        title: "일정",
        rule: { ...base, frequency: "daily" },
      });
      const e = s.list("2026-09-03", "2026-09-04")[0];
      s.mutate(i.id, e.key, 1, scope, null, true);
      assert.equal(
        s.list("2026-09-01", "2026-09-06").length,
        scope === "future" ? 2 : 0,
      );
      s.restore(s.trash()[0].id as string);
      assert.equal(s.list("2026-09-01", "2026-09-06").length, 5);
    } finally {
      s.db.close();
    }
  }
});
test("timed and all-day reminders are derived in KST; completed/undated never notify", () => {
  const f = { ...defaultFields("2026-09-10"), title: "일정" };
  assert.equal(
    new Date(reminderAt(f)!).toISOString(),
    "2026-09-10T00:00:00.000Z",
  );
  assert.equal(reminderAt({ ...f, done: true }), null);
  assert.equal(reminderAt(defaultFields(null)), null);
});
test("time layout packs overlapping events side-by-side and separates adjacent groups", () => {
  const s = new Store(":memory:");
  try {
    for (const [start, end] of [
      ["09:00", "11:00"],
      ["10:00", "12:00"],
      ["12:00", "13:00"],
    ])
      s.create({
        ...defaultFields("2026-09-10"),
        title: start,
        kind: "timed",
        start: toUTC(`2026-09-10T${start}`),
        end: toUTC(`2026-09-10T${end}`),
        reminder: 10,
      });
    const layout = timeLayout(s.list("2026-09-10", "2026-09-11"), "2026-09-10");
    assert.deepEqual(
      layout.map((x) => [x.column, x.columns]),
      [
        [0, 2],
        [1, 2],
        [0, 1],
      ],
    );
  } finally {
    s.db.close();
  }
});
