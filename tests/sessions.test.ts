import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/server/store.js";
import { createApp } from "../src/server/app.js";
import { hash } from "../src/server/auth.js";
import { deviceName } from "../src/server/session-info.js";
import type { Config } from "../src/server/config.js";
const cfg: Config = {
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
async function fixture() {
  const store = new Store(":memory:");
  for (const session of ["current-secret", "other-secret", "expired-secret"])
    store.db
      .prepare("INSERT INTO sessions VALUES(?,?)")
      .run(
        hash(session),
        Date.now() + (session === "expired-secret" ? -1 : 600000),
      );
  const { app, close } = createApp(store, cfg);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = (
    path: string,
    body?: unknown,
    session = "current-secret",
    extra: Record<string, string> = {},
  ) =>
    fetch(base + path, {
      headers: {
        ...(session ? { Cookie: `plan_session=${session}` } : {}),
        "User-Agent":
          "Mozilla/5.0 (Linux; Android 14) Chrome/123.0 Mobile Safari/537.36",
        ...(body !== undefined
          ? { "Content-Type": "application/json", Origin: cfg.origin }
          : {}),
        ...extra,
      },
      ...(body !== undefined
        ? { method: "POST", body: JSON.stringify(body) }
        : {}),
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
test("Session list identifies this browser without exposing credentials, preserves legacy sessions", async () => {
  const f = await fixture();
  try {
    const response = await f.request("/api/sessions");
    assert.equal(response.status, 200);
    const { sessions } = await response.json();
    assert.equal(sessions.length, 2);
    assert.equal(sessions[0].current, true);
    assert.equal(sessions[0].device, "Android · Chrome");
    assert.equal(sessions[0].createdAt, null);
    assert(sessions[0].lastSeenAt);
    assert.equal(sessions[1].device, "알 수 없는 기기");
    assert.equal(sessions[1].lastSeenAt, null);
    const raw = JSON.stringify(sessions);
    for (const token of ["current-secret", "other-secret"]) {
      assert(!raw.includes(token));
      assert(!raw.includes(hash(token)));
    }
    const other = await (
      await f.request("/api/sessions", undefined, "other-secret")
    ).json();
    assert.equal(other.sessions[0].id, sessions[1].id);
    assert.equal(other.sessions[0].current, true);
    assert.equal(
      other.sessions.filter((s: { current: boolean }) => s.current).length,
      1,
    );
    assert.equal(
      f.store.db.prepare("SELECT count(*) AS n FROM sessions").get()!.n,
      3,
    );
  } finally {
    await f.cleanup();
  }
});
test("Sessions reject unauthenticated, bearer, foreign-origin and malformed management requests", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request("/api/sessions", undefined, "")).status, 401);
    assert.equal(
      (await f.request("/api/sessions", undefined, "expired-secret")).status,
      401,
    );
    assert.equal(
      (
        await f.request("/api/sessions", undefined, "current-secret", {
          Authorization: "Bearer token",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await f.request("/api/sessions/revoke-others", {}, "current-secret", {
          Origin: "https://evil.example",
        })
      ).status,
      403,
    );
    assert.equal(
      (await f.request("/api/sessions/revoke-others", { arbitrary: true }))
        .status,
      400,
    );
    assert.equal(
      (await f.request("/api/sessions/revoke-others", [], "current-secret"))
        .status,
      400,
    );
    assert.equal(
      (await f.request("/api/sessions/nonexistent/revoke", {})).status,
      404,
    );
    assert.equal(
      f.store.db.prepare("SELECT count(*) AS n FROM sessions").get()!.n,
      3,
    );
  } finally {
    await f.cleanup();
  }
});
test("Individual and bulk revocation preserve this session; self-revocation clears the cookie", async () => {
  const f = await fixture();
  try {
    const { sessions } = await (await f.request("/api/sessions")).json();
    const current = sessions.find((s: { current: boolean }) => s.current);
    const other = sessions.find((s: { current: boolean }) => !s.current);
    assert.deepEqual(
      await (await f.request(`/api/sessions/${other.id}/revoke`, {})).json(),
      { current: false },
    );
    assert.equal(
      (await f.request("/api/sessions", undefined, "other-secret")).status,
      401,
    );
    assert.equal((await f.request("/api/sessions")).status, 200);
    assert.equal(
      f.store.db
        .prepare("SELECT count(*) AS n FROM session_details WHERE id=?")
        .get(other.id)!.n,
      0,
    );
    f.store.db
      .prepare("INSERT INTO sessions VALUES(?,?)")
      .run(hash("third-secret"), Date.now() + 600000);
    assert.equal(
      (await (await f.request("/api/sessions/revoke-others", {})).json()).count,
      1,
    );
    assert.equal(
      (await f.request("/api/sessions", undefined, "third-secret")).status,
      401,
    );
    assert.equal((await f.request("/api/sessions")).status, 200);
    const self = await f.request(`/api/sessions/${current.id}/revoke`, {});
    assert.equal((await self.json()).current, true);
    assert.match(self.headers.get("set-cookie")!, /plan_session=;/);
    assert.equal((await f.request("/api/sessions")).status, 401);
  } finally {
    await f.cleanup();
  }
});
test("Device labels are conservative and never echo raw user-agent markup", () => {
  assert.equal(deviceName(""), "알 수 없는 기기");
  assert.equal(
    deviceName(
      "Mozilla/5.0 (Linux; Android 14) Chrome/123 Safari/537.36 SamsungBrowser/25",
    ),
    "Android · Samsung Internet",
  );
  assert.equal(
    deviceName(
      "Mozilla/5.0 (Windows NT 10.0) Chrome/123 Safari/537.36 Edg/123",
    ),
    "Windows · Edge",
  );
  assert.equal(deviceName("<script>alert(1)</script>"), "기기 · 브라우저");
});
