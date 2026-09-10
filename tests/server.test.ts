import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { Store } from "../src/server/store.js";
import { createApp } from "../src/server/app.js";
import { hash } from "../src/server/auth.js";
import { config, type Config } from "../src/server/config.js";
import {
  defaultFields,
  today,
  addDays,
  DAY,
  type Occurrence,
} from "../src/shared/domain.js";
import { pushWorker, validateSubscription } from "../src/server/push.js";
const cfg: Config = {
  origin: "http://localhost:3000",
  owner: "crasnec@gmail.com",
  clientId: "",
  clientSecret: "",
  vapidPublic: "",
  vapidPrivate: "",
  vapidSubject: "mailto:crasnec@gmail.com",
  demo: false,
  production: false,
};
async function fixture() {
  const store = new Store(":memory:");
  const { app, close } = createApp(store, cfg);
  store.db
    .prepare("INSERT INTO sessions VALUES(?,?)")
    .run(hash("test-owner-session"), Date.now() + 60000);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const port = (server.address() as { port: number }).port;
  const request = (
    path: string,
    body?: unknown,
    owner = false,
    origin = cfg.origin,
  ) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      headers: {
        ...(owner ? { cookie: "plan_session=test-owner-session" } : {}),
        ...(body === undefined
          ? {}
          : { "Content-Type": "application/json", Origin: origin }),
      },
      ...(body === undefined
        ? {}
        : { method: "POST", body: JSON.stringify(body) }),
    });
  return {
    store,
    request,
    cleanup: async () => {
      close();
      await new Promise<void>((r) => server.close(() => r()));
      store.db.close();
    },
  };
}
test("unauthenticated writes and reads are denied; foreign-origin writes denied", async () => {
  const f = await fixture();
  try {
    assert.equal(
      (await f.request("/api/items?from=2026-09-01&to=2026-10-01")).status,
      401,
    );
    assert.equal(
      (await f.request("/api/items", { ...defaultFields(), title: "x" }))
        .status,
      401,
    );
    assert.equal(
      (
        await f.request(
          "/api/items",
          { ...defaultFields(), title: "x" },
          true,
          "https://evil.example",
        )
      ).status,
      403,
    );
    assert.equal(
      (await f.request("/api/items", { ...defaultFields(), title: "x" }, true))
        .status,
      201,
    );
    assert.equal(
      (await f.request("/api/items", { ...defaultFields(), title: "" }, true))
        .status,
      400,
    );
  } finally {
    await f.cleanup();
  }
});
test("shared projection hides private entries, rule details, reminders; link rotation revokes access", async () => {
  const f = await fixture();
  try {
    f.store.create({
      ...defaultFields("2026-09-10"),
      title: "비밀",
      notes: "private-notes",
    });
    f.store.create({
      ...defaultFields("2026-09-10"),
      title: "공개",
      public: true,
    });
    const link = (await (
      await f.request("/api/share", { action: "rotate" }, true)
    ).json()) as { url: string };
    const key = link.url.split("/").pop();
    const result = await f.request(
      `/api/items?from=2026-09-01&to=2026-10-01&share=${key}`,
    );
    const events = (await result.json()) as Occurrence[];
    assert.equal(events.length, 1);
    assert.equal(events[0].title, "공개");
    assert.equal(events[0].rule, null);
    assert.equal(events[0].reminder, null);
    assert.equal(events[0].seriesStart, null);
    assert.equal((await f.request("/api/share")).status, 401);
    await f.request("/api/share", { action: "rotate" }, true);
    assert.equal(
      (await f.request(`/api/items?from=2026-09-01&to=2026-10-01&share=${key}`))
        .status,
      404,
    );
  } finally {
    await f.cleanup();
  }
});
test("expired sessions cannot edit; logout invalidates the stored session", async () => {
  const f = await fixture();
  try {
    f.store.db.prepare('UPDATE sessions SET expires=?').run(Date.now()-1);
    assert.equal((await (await f.request('/api/me',undefined,true)).json()).owner,false);
    assert.equal((await f.request('/api/items',{...defaultFields(),title:'expired'},true)).status,401);
    f.store.db.prepare('UPDATE sessions SET expires=?').run(Date.now()+60000);
    await f.request("/api/logout", {}, true);
    assert.equal((await f.request("/api/me", undefined, true)).status, 200);
    assert.equal(
      (await (await f.request("/api/me", undefined, true)).json()).owner,
      false,
    );
    assert.equal(
      (await f.request("/api/items", { ...defaultFields(), title: "x" }, true))
        .status,
      401,
    );
  } finally {
    await f.cleanup();
  }
});
test("OAuth callbacks reject missing state and no credentials means unavailable", async () => {
  const f = await fixture();
  try {
    assert.equal(
      (await f.request("/auth/google/callback?code=fake&state=fake")).status,
      400,
    );
    assert.equal((await f.request("/auth/google")).status, 503);
  } finally {
    await f.cleanup();
  }
});
test("long query ranges and invalid mutation keys fail without changing data", async () => {
  const f = await fixture();
  try {
    assert.equal(
      (
        await f.request(
          "/api/items?from=2026-01-01&to=2027-01-01",
          undefined,
          true,
        )
      ).status,
      400,
    );
    const i = f.store.create({ ...defaultFields(), title: "원본" });
    assert.equal(
      (
        await f.request(
          `/api/items/${i.id}/change`,
          {
            key: "wrong",
            version: 1,
            scope: "all",
            fields: { ...i, title: "수정" },
            deleting: false,
          },
          true,
        )
      ).status,
      400,
    );
    assert.equal(f.store.item(i.id).title, "원본");
  } finally {
    await f.cleanup();
  }
});
test("SQLite persistence and native online backup restore the actual records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "plan-db-test-"));
  try {
    const path = join(directory, "plan.sqlite"),
      target = join(directory, "backup.sqlite");
    let s = new Store(path);
    const i = s.create({ ...defaultFields(), title: "영구 보관" });
    s.db.close();
    s = new Store(path);
    assert.equal(s.item(i.id).title, "영구 보관");
    await backup(s.db, target);
    s.db.close();
    const restored = new Store(target);
    assert.equal(restored.item(i.id).title, "영구 보관");
    assert.equal(
      restored.db.prepare("PRAGMA integrity_check").get()!.integrity_check,
      "ok",
    );
    restored.db.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("expired trash is purged; recurring tombstones still suppress old deleted occurrences", () => {
  const s = new Store(":memory:");
  try {
    const i = s.create({ ...defaultFields("2026-09-01"), title: "old" });
    s.mutate(i.id, "single", 1, "all", null, true);
    s.db.prepare("UPDATE trash SET deleted_at=?").run(Date.now() - 31 * DAY);
    s.cleanup();
    assert.equal(s.trash().length, 0);
    const repeating=s.create({...defaultFields('2026-09-01'),title:'반복',rule:{frequency:'daily',interval:1,weekdays:[0],monthly:'date',day:1,ordinal:1,weekday:0,until:null}});
    s.mutate(repeating.id,'2026-09-01',1,'one',null,true);
    s.db.prepare('UPDATE trash SET deleted_at=?').run(Date.now()-31*DAY);
    s.cleanup();
    assert.equal(s.trash().length,0);
    assert.equal(s.list('2026-09-01','2026-09-02').length,0);
  } finally {
    s.db.close();
  }
});
test("push subscriptions reject loopback, credentials, redirects and arbitrary hosts", () => {
  const keys = { p256dh: "A".repeat(87), auth: "A".repeat(22) };
  for (const endpoint of [
    "http://127.0.0.1/",
    "https://example.com/",
    "https://fcm.googleapis.com.evil.test/",
    "https://user@fcm.googleapis.com/",
    "https://fcm.googleapis.com:8443/",
  ])
    assert.throws(() => validateSubscription({ endpoint, keys }));
});
test("notification worker sends once per due occurrence/device; completion cancels future work", async () => {
  const s = new Store(":memory:");
  let calls = 0;
  const worker = pushWorker(
    s,
    { ...cfg, vapidPublic: "configured", vapidPrivate: "configured" },
    (async () => {
      calls++;
      return { statusCode: 201, body: "", headers: {} };
    }) as never,
  );
  try {
    const now = Date.now();
    const i = s.create({
      ...defaultFields(today()),
      title: "알림",
      kind: "timed",
      start: new Date(now - 1000).toISOString(),
      end: new Date(now + 60000).toISOString(),
      reminder: 0,
    });
    s.db
      .prepare("INSERT INTO subscriptions VALUES(?,?,?)")
      .run(
        "device",
        JSON.stringify({
          endpoint: "https://fcm.googleapis.com/test",
          keys: {},
        }),
        now - 60000,
      );
    await worker.tick();
    await worker.tick();
    assert.equal(calls, 1);
    s.mutate(i.id, "single", 1, "one", { ...i, done: true });
    await worker.tick();
    assert.equal(calls, 1);
    assert.equal(
      s.db.prepare("SELECT state FROM deliveries").get()!.state,
      "sent",
    );
  } finally {
    worker.stop();
    s.db.close();
  }
});
