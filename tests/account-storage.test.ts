import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/server/store.js";
import { defaultFields } from "../src/shared/domain.js";
import { subscribe } from "../src/server/push.js";

test("Account migration preserves existing foreign keys and survives reopening and rejoining", () => {
  const dir = mkdtempSync(join(tmpdir(), "plan-account-"));
  const path = join(dir, "test.sqlite");
  let store = new Store(path);
  try {
    const user = store.createUser("a@example.com", "google-sub");
    store.create(user.id, { ...defaultFields(null), title: "existing" });
    store.db.prepare("INSERT INTO invites VALUES(?,?,?,?,?,?,?,?)").run("invite", "hash", user.id, 1, 9999999999999, null, null, null);
    // Restore the actual v6 identity schema with its global uniqueness constraint.
    store.db.exec(`PRAGMA foreign_keys=OFF;
      CREATE TABLE users_old(id TEXT PRIMARY KEY, email TEXT NOT NULL, google_sub TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, share_hash TEXT, preferences TEXT, history_version INTEGER NOT NULL DEFAULT 0);
      INSERT INTO users_old SELECT id,email,google_sub,created_at,share_hash,preferences,history_version FROM users;
      DROP TABLE users;
      ALTER TABLE users_old RENAME TO users;
      ALTER TABLE deliveries DROP COLUMN user_id;
      DELETE FROM migrations WHERE version=7;`);
    store.db.close();
    store = new Store(path);
    assert.equal(store.user(user.id)?.googleSub, "google-sub");
    assert.equal(store.items(user.id).length, 1);
    assert.deepEqual(store.db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(store.db.prepare("PRAGMA foreign_keys").get()!.foreign_keys, 1);
    assert.throws(() => store.createUser(user.email, user.googleSub));
    store.withdrawUser(user.id);
    const fresh = store.createUser(user.email, user.googleSub);
    assert.notEqual(user.id, fresh.id);
    store.db.close();
    store = new Store(path);
    assert.equal(store.user(user.id), undefined);
    assert.equal(store.userBySub(user.googleSub)?.id, fresh.id);
    assert.deepEqual(store.items(user.id), []);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM items").get()!.n, 1);
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true });
  }
});

test("Withdrawal rolls back atomically and retains subscriptions when a browser rejoins", () => {
  const store = new Store(":memory:");
  try {
    const user = store.createUser("a@example.com", "sub");
    const subscription = { endpoint: "https://fcm.googleapis.com/push/test", keys: { p256dh: "a".repeat(87), auth: "b".repeat(22) } };
    const id = subscribe(store, user.id, subscription);
    store.db.exec("CREATE TRIGGER fail_withdraw BEFORE UPDATE ON invites BEGIN SELECT RAISE(ABORT,'simulated failure'); END");
    store.db.prepare("INSERT INTO invites VALUES(?,?,?,?,?,?,?,?)").run("invite", "hash", user.id, 1, 9999999999999, null, null, null);
    assert.throws(() => store.withdrawUser(user.id), /simulated failure/);
    assert(store.user(user.id));
    store.db.exec("DROP TRIGGER fail_withdraw");
    store.withdrawUser(user.id);
    const fresh = store.createUser(user.email, user.googleSub);
    assert.equal(subscribe(store, fresh.id, subscription), id);
    const rows = store.db.prepare("SELECT * FROM subscriptions").all();
    assert.equal(rows.length, 2);
    assert.equal(rows.find((r) => r.user_id === user.id)!.data, JSON.stringify(subscription));
    assert.equal(rows.find((r) => r.id === id)!.user_id, fresh.id);
  } finally {
    store.db.close();
  }
});

test("Withdrawal stops queued notifications, including a tick already sending to another device", async () => {
  const { pushWorker } = await import("../src/server/push.js");
  const { config } = await import("../src/server/config.js");
  const store = new Store(":memory:");
  const user = store.createUser("a@example.com", "sub");
  const now = Date.now();
  store.create(user.id, {
    ...defaultFields(null), title: "due", kind: "timed",
    start: new Date(now - 60000).toISOString(),
    end: new Date(now + 60000).toISOString(), reminder: 0,
  });
  for (const id of ["device-1", "device-2"])
    store.db.prepare("INSERT INTO subscriptions VALUES(?,?,?,?)").run(id, "{}", now - 120000, user.id);
  let sent = 0;
  const worker = pushWorker(store, { ...config(), vapidPublic: "test", vapidPrivate: "test" }, async () => {
    sent++;
    store.withdrawUser(user.id);
    return { statusCode: 201, headers: {}, body: "" };
  });
  try {
    await worker.tick();
    assert.equal(sent, 1);
    await worker.tick();
    assert.equal(sent, 1);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM subscriptions").get()!.n, 2);
  } finally {
    worker.stop();
    store.db.close();
  }
});
