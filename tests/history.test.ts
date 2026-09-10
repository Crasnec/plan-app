import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/server/store.js";
import { History } from "../src/server/history.js";
import { defaultFields } from "../src/shared/domain.js";
import { createApp } from "../src/server/app.js";
import { hash } from "../src/server/auth.js";

test("History expires and a failed undo rolls back without consuming the action", () => {
  const s = new Store(":memory:"),
    h = new History(s);
  const now = Date.now;
  try {
    h.record("a", "create", () =>
      s.create({ ...defaultFields(null), title: "atomic" }),
    );
    const state = h.state("a");
    s.db.exec(
      "CREATE TRIGGER block_history_delete BEFORE DELETE ON items BEGIN SELECT RAISE(ABORT, 'test rollback'); END",
    );
    assert.throws(() => h.apply("a", "undo", state.undo!.id), /test rollback/);
    assert.equal(s.items().length, 1);
    assert.equal(s.setting("history_version"), null);
    assert.deepEqual(h.state("a"), state);
    Date.now = () => now() + 31 * 60000;
    assert.deepEqual(h.state("a"), { undo: null, redo: null });
    assert.equal(s.items().length, 1);
  } finally {
    Date.now = now;
    s.db.close();
  }
});

test("History supports multiple undo/redo, monotonic versions and stale request rejection", () => {
  const s = new Store(":memory:"),
    h = new History(s);
  try {
    const item = h.record("a", "create", () =>
      s.create({ ...defaultFields("2026-09-10"), title: "first" }),
    );
    h.record("a", "edit", () =>
      s.mutate(item.id, "single", 1, "all", { ...item, title: "second" }),
    );
    const editId = h.state("a").undo!.id;
    h.apply("a", "undo", editId);
    assert.equal(s.item(item.id).title, "first");
    assert(s.item(item.id).version > 2);
    assert.throws(() => h.apply("a", "undo", editId));
    assert.throws(() =>
      s.mutate(item.id, "single", 2, "all", { ...item, title: "stale" }),
    );
    h.apply("a", "undo", h.state("a").undo!.id);
    assert.equal(s.items().length, 0);
    h.apply("a", "redo", h.state("a").redo!.id);
    h.apply("a", "redo", h.state("a").redo!.id);
    assert.equal(s.item(item.id).title, "second");
    assert(s.item(item.id).version > 3);
  } finally {
    s.db.close();
  }
});
test("History refuses concurrent agent/session changes without overwriting them", () => {
  const s = new Store(":memory:"),
    h = new History(s);
  try {
    const item = h.record("a", "create", () =>
      s.create({ ...defaultFields(null), title: "first" }),
    );
    assert.deepEqual(h.state("b"), { undo: null, redo: null });
    s.mutate(item.id, "single", 1, "all", { ...item, title: "agent change" });
    assert.throws(
      () => h.apply("a", "undo", h.state("a").undo!.id),
      /다른 작업/,
    );
    assert.equal(s.item(item.id).title, "agent change");
    h.record("a", "new", () =>
      s.create({ ...defaultFields(null), title: "new" }),
    );
    h.apply("a", "undo", h.state("a").undo!.id);
    assert.equal(h.state("a").undo, null);
    assert.equal(s.item(item.id).title, "agent change");
  } finally {
    s.db.close();
  }
});
test("Deleting and restoring recurring schedules can be undone; new edits clear redo", () => {
  const s = new Store(":memory:"),
    h = new History(s);
  try {
    const item = h.record("a", "create", () =>
      s.create({
        ...defaultFields("2026-09-01"),
        title: "repeat",
        rule: {
          frequency: "daily",
          interval: 1,
          weekdays: [0],
          monthly: "date",
          day: 1,
          ordinal: 1,
          weekday: 0,
          until: null,
        },
      }),
    );
    const event = s.list("2026-09-02", "2026-09-03")[0];
    h.record("a", "delete", () =>
      s.mutate(item.id, event.key, event.version, "one", event, true),
    );
    assert.equal(s.list("2026-09-02", "2026-09-03").length, 0);
    const trash = s.trash()[0];
    h.record("a", "restore", () => s.restore(trash.id));
    assert.equal(s.list("2026-09-02", "2026-09-03").length, 1);
    h.apply("a", "undo", h.state("a").undo!.id);
    assert.equal(s.list("2026-09-02", "2026-09-03").length, 0);
    assert.equal(s.trash().length, 1);
    h.apply("a", "undo", h.state("a").undo!.id);
    assert.equal(s.list("2026-09-02", "2026-09-03").length, 1);
    assert.equal(s.trash().length, 0);
    h.record("a", "new", () =>
      s.create({ ...defaultFields(null), title: "new" }),
    );
    assert.equal(h.state("a").redo, null);
    const previous = h.state("a");
    assert.throws(() => h.record("a", "bad", () => s.create({} as never)));
    assert.deepEqual(h.state("a"), previous);
  } finally {
    s.db.close();
  }
});
test("History is limited to 20 operations and is cleared on process restart", () => {
  const s = new Store(":memory:"),
    h = new History(s);
  try {
    for (let i = 0; i < 21; i++)
      h.record("a", "create", () =>
        s.create({ ...defaultFields(null), title: String(i) }),
      );
    for (let i = 0; i < 20; i++) h.apply("a", "undo", h.state("a").undo!.id);
    assert.equal(h.state("a").undo, null);
    assert.equal(s.items().length, 1);
    assert.equal(new History(s).state("a").redo, null);
  } finally {
    s.db.close();
  }
});
test("History endpoints require owner session and same-origin JSON; stale undo IDs fail", async () => {
  const s = new Store(":memory:");
  const cfg = {
    origin: "http://localhost:3000",
    owner: "owner@example.com",
    clientId: "",
    clientSecret: "",
    vapidPublic: "",
    vapidPrivate: "",
    vapidSubject: "mailto:owner@example.com",
    demo: false,
    production: false,
  };
  const { app, close } = createApp(s, cfg);
  s.db
    .prepare("INSERT INTO sessions VALUES(?,?)")
    .run(hash("owner"), Date.now() + 60000);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const headers = {
    Cookie: "plan_session=owner",
    Origin: cfg.origin,
    "Content-Type": "application/json",
  };
  try {
    assert.equal((await fetch(base + "/api/history")).status, 401);
    assert.equal(
      (
        await fetch(base + "/api/history", {
          headers: { ...headers, Authorization: "Bearer invalid" },
        })
      ).status,
      403,
    );
    await fetch(base + "/api/items", {
      method: "POST",
      headers,
      body: JSON.stringify({ ...defaultFields(null), title: "undo me" }),
    });
    const state = await (
      await fetch(base + "/api/history", { headers })
    ).json();
    assert.equal(
      (
        await fetch(base + "/api/history/undo", {
          method: "POST",
          headers: { ...headers, Origin: "https://other.invalid" },
          body: JSON.stringify({ id: state.undo.id }),
        })
      ).status,
      403,
    );
    const undo = () =>
      fetch(base + "/api/history/undo", {
        method: "POST",
        headers,
        body: JSON.stringify({ id: state.undo.id }),
      });
    assert.equal((await undo()).status, 200);
    assert.equal((await undo()).status, 409);
    assert.equal(s.items().length, 0);
  } finally {
    close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    s.db.close();
  }
});
