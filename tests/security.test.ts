import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  mkdir,
  chmod,
  stat,
  readdir,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Store } from "../src/server/store.js";
import { createApp } from "../src/server/app.js";
import { hash } from "../src/server/auth.js";
import type { Config } from "../src/server/config.js";

const cfg: Config = {
  origin: "http://localhost:3000",
  owner: "crasnec@gmail.com",
  clientId: "test",
  clientSecret: "test",
  vapidPublic: "",
  vapidPrivate: "",
  vapidSubject: "mailto:crasnec@gmail.com",
  demo: false,
  production: false,
};
async function fixture() {
  const store = new Store(":memory:");
  const { app, close } = createApp(store, cfg);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  return {
    store,
    url: `http://127.0.0.1:${address.port}`,
    cleanup: async () => {
      close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.db.close();
    },
  };
}

test("OAuth global rate limits ignore spoofed proxy addresses", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 8; i++) {
      const r = await fetch(`${f.url}/auth/google`, {
        redirect: "manual",
        headers: { "X-Forwarded-For": `192.0.2.${i}` },
      });
      assert.equal(r.status, i < 5 ? 302 : 429);
      if (i >= 5) assert(Number(r.headers.get("Retry-After")) > 0);
    }
    assert.equal(
      f.store.db.prepare("SELECT count(*) AS n FROM oauth").get()!.n,
      5,
    );
    for (let i = 0; i < 21; i++) {
      const r = await fetch(`${f.url}/auth/google/callback`);
      assert.equal(r.status, i < 20 ? 400 : 429);
    }
  } finally {
    await f.cleanup();
  }
});

test("OAuth pending-state cap and expired-state cleanup", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 100; i++)
      f.store.db
        .prepare("INSERT INTO oauth VALUES(?,?,?)")
        .run(`state-${i}`, Date.now() + 600000, "{}");
    assert.equal(
      (await fetch(`${f.url}/auth/google`, { redirect: "manual" })).status,
      429,
    );
    assert.equal(
      f.store.db.prepare("SELECT count(*) AS n FROM oauth").get()!.n,
      100,
    );
    f.store.db.prepare("UPDATE oauth SET expires=0").run();
    assert.equal(
      (await fetch(`${f.url}/auth/google`, { redirect: "manual" })).status,
      302,
    );
    assert.equal(
      f.store.db.prepare("SELECT count(*) AS n FROM oauth").get()!.n,
      1,
    );
  } finally {
    await f.cleanup();
  }
});

test("OAuth invalid state formats and mismatches return 400", async () => {
  const f = await fixture();
  try {
    for (const state of [
      "é".repeat(43),
      "a".repeat(42),
      "!".repeat(43),
      "b".repeat(43),
      "",
    ]) {
      const r = await fetch(
        `${f.url}/auth/google/callback?state=${encodeURIComponent(state)}&code=invalid`,
        { headers: { Cookie: `plan_oauth=${"a".repeat(43)}` } },
      );
      assert.equal(r.status, 400);
    }
  } finally {
    await f.cleanup();
  }
});

test("Logout closes only matching SSE sessions; revoked sessions cannot receive broadcasts", async () => {
  const f = await fixture();
  const streams: ReadableStreamDefaultReader<Uint8Array>[] = [];
  const read = (reader: ReadableStreamDefaultReader<Uint8Array>) => {
    let timer: ReturnType<typeof setTimeout>;
    return Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("SSE timeout")), 1500);
      }),
    ]).finally(() => clearTimeout(timer));
  };
  const post = (path: string, session: string, body: unknown) =>
    fetch(`${f.url}${path}`, {
      method: "POST",
      headers: {
        Cookie: `plan_session=${session}`,
        Origin: cfg.origin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  try {
    for (const session of ["a", "b", "c"]) {
      f.store.db
        .prepare("INSERT INTO sessions VALUES(?,?)")
        .run(hash(session), Date.now() + 60000);
      const r = await fetch(`${f.url}/api/events`, {
        headers: { Cookie: `plan_session=${session}` },
      });
      assert.equal(r.status, 200);
      streams.push(r.body!.getReader());
      await read(streams.at(-1)!);
    }
    assert.equal((await post("/api/logout", "a", {})).status, 200);
    assert.equal((await read(streams[0])).done, true);
    f.store.db
      .prepare("UPDATE sessions SET expires=0 WHERE hash=?")
      .run(hash("c"));
    const created = await post("/api/items", "b", {
      title: "security test",
      notes: "",
      kind: "undated",
      start: null,
      end: null,
      public: false,
      done: false,
      reminder: null,
      rule: null,
    });
    assert.equal(created.status, 201);
    assert.match(
      new TextDecoder().decode((await read(streams[1])).value),
      /event: change/,
    );
    assert.equal((await read(streams[2])).done, true);
  } finally {
    for (const reader of streams) await reader.cancel();
    await f.cleanup();
  }
});

test("Backup is private under umask 022 and rejects unsafe existing destinations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "plan-backup-security-"));
  const source = join(directory, "plan.sqlite");
  const store = new Store(source);
  store.db.close();
  const destination = join(directory, "backups");
  const run = (target = destination) => {
    const mask = process.umask(0o022);
    try {
      return spawnSync(process.execPath, ["scripts/backup.mjs"], {
        env: { ...process.env, DATABASE_PATH: source, BACKUP_DIR: target },
        encoding: "utf8",
      });
    } finally {
      process.umask(mask);
    }
  };
  try {
    for (let i = 0; i < 2; i++) {
      const r = run();
      assert.equal(r.status, 0, r.stderr);
    }
    assert.equal((await stat(destination)).mode & 0o777, 0o700);
    const files = await readdir(destination);
    assert.equal(files.filter((file) => file.endsWith(".sqlite")).length, 2);
    for (const file of files)
      assert.equal((await stat(join(destination, file))).mode & 0o777, 0o600);
    const unsafe = join(directory, "unsafe");
    await mkdir(unsafe);
    await chmod(unsafe, 0o755);
    assert.notEqual(run(unsafe).status, 0);
    assert.deepEqual(await readdir(unsafe), []);
    assert.equal((await stat(unsafe)).mode & 0o777, 0o755);
    const link = join(directory, "link");
    await symlink(destination, link);
    assert.notEqual(run(link).status, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
