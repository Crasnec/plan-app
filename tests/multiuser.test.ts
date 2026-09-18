import test from "node:test";
import assert from "node:assert/strict";
import { OAuth2Client } from "google-auth-library";
import { createApp } from "../src/server/app.js";
import { Store } from "../src/server/store.js";
import { hash } from "../src/server/auth.js";
import { defaultFields } from "../src/shared/domain.js";
import type { Config } from "../src/server/config.js";

const cfg: Config = {
  origin: "http://localhost:3000",
  owner: "first@example.com",
  clientId: "",
  clientSecret: "",
  vapidPublic: "",
  vapidPrivate: "",
  vapidSubject: "mailto:first@example.com",
  demo: false,
  production: false,
};

function mockGoogle() {
  const originalGet = OAuth2Client.prototype.getToken;
  const originalVerify = OAuth2Client.prototype.verifyIdToken;
  OAuth2Client.prototype.getToken = (async (opts: { code: string }) => ({
    tokens: { id_token: opts.code },
  })) as unknown as typeof originalGet;
  OAuth2Client.prototype.verifyIdToken = (async (opts: {
    idToken: string;
  }) => ({
    getPayload: () => JSON.parse(decodeURIComponent(opts.idToken)),
  })) as unknown as typeof originalVerify;
  return () => {
    OAuth2Client.prototype.getToken = originalGet;
    OAuth2Client.prototype.verifyIdToken = originalVerify;
  };
}
async function login(
  base: string,
  store: Store,
  email: string,
  sub: string,
  invite?: string,
) {
  const state = hash(`${email}:${sub}:${Math.random()}`).slice(0, 43);
  store.db
    .prepare("INSERT INTO oauth VALUES(?,?,?)")
    .run(
      hash(state),
      Date.now() + 60000,
      JSON.stringify({ nonce: "n", verifier: "v", returnTo: "/", invite: invite ?? null }),
    );
  const code = encodeURIComponent(
    JSON.stringify({ email, email_verified: true, sub, nonce: "n" }),
  );
  const res = await fetch(
    `${base}/auth/google/callback?state=${state}&code=${code}`,
    { redirect: "manual", headers: { Cookie: `plan_oauth=${state}` } },
  );
  const setCookie = res.headers.get("set-cookie");
  const session = setCookie ? /plan_session=([^;]+)/.exec(setCookie)?.[1] : undefined;
  return { status: res.status, session };
}
async function fixture() {
  const store = new Store(":memory:");
  const { app, close } = createApp(store, cfg);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${(address as { port: number }).port}`;
  const call = (path: string, session?: string, init: RequestInit = {}) =>
    fetch(base + path, {
      ...init,
      headers: {
        ...(session ? { Cookie: `plan_session=${session}` } : {}),
        ...(init.body !== undefined
          ? { "Content-Type": "application/json", Origin: cfg.origin }
          : {}),
        ...init.headers,
      },
    });
  return {
    store,
    base,
    call,
    cleanup: async () => {
      close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.db.close();
    },
  };
}
async function invite(f: Awaited<ReturnType<typeof fixture>>, session: string) {
  const r = await f.call("/api/invites", session, { method: "POST", body: "{}" });
  assert.equal(r.status, 201);
  const data = (await r.json()) as { url: string; id: string };
  return { id: data.id, token: data.url.split("/").pop()! };
}

test("Two users' items, trash and undo history stay fully isolated", async () => {
  const restore = mockGoogle();
  const f = await fixture();
  try {
    const first = await login(f.base, f.store, cfg.owner, "sub-1");
    assert.equal(first.status, 302);
    const inv = await invite(f, first.session!);
    const second = await login(f.base, f.store, "second@example.com", "sub-2", inv.token);
    assert.equal(second.status, 302);

    const createA = await f.call("/api/items", first.session, {
      method: "POST",
      body: JSON.stringify({ ...defaultFields(null), title: "A only" }),
    });
    assert.equal(createA.status, 201);
    const createB = await f.call("/api/items", second.session, {
      method: "POST",
      body: JSON.stringify({ ...defaultFields(null), title: "B only" }),
    });
    assert.equal(createB.status, 201);

    const listA = await (
      await f.call("/api/items?from=2026-01-01&to=2026-02-01", first.session)
    ).json();
    const listB = await (
      await f.call("/api/items?from=2026-01-01&to=2026-02-01", second.session)
    ).json();
    assert.deepEqual(
      listA.map((i: { title: string }) => i.title),
      ["A only"],
    );
    assert.deepEqual(
      listB.map((i: { title: string }) => i.title),
      ["B only"],
    );

    // Undo on A's session must not touch B's data, and vice versa.
    const undoA = await (await f.call("/api/history", first.session)).json();
    assert.equal(undoA.undo.label, "일정 생성");
    await f.call("/api/history/undo", first.session, {
      method: "POST",
      body: JSON.stringify({ id: undoA.undo.id }),
    });
    const afterUndoA = await (
      await f.call("/api/items?from=2026-01-01&to=2026-02-01", first.session)
    ).json();
    assert.deepEqual(afterUndoA, []);
    const stillB = await (
      await f.call("/api/items?from=2026-01-01&to=2026-02-01", second.session)
    ).json();
    assert.deepEqual(
      stillB.map((i: { title: string }) => i.title),
      ["B only"],
    );

    // Deleting B's item must not appear in A's trash.
    const bItem = await createB.clone().json();
    await f.call(`/api/items/${bItem.id}/change`, second.session, {
      method: "POST",
      body: JSON.stringify({
        key: "single",
        version: 1,
        scope: "one",
        fields: null,
        deleting: true,
      }),
    });
    const trashA = await (await f.call("/api/trash", first.session)).json();
    const trashB = await (await f.call("/api/trash", second.session)).json();
    assert.deepEqual(trashA, []);
    assert.equal(trashB.length, 1);
  } finally {
    restore();
    await f.cleanup();
  }
});

test("A share link only exposes the sharing user's own public items", async () => {
  const restore = mockGoogle();
  const f = await fixture();
  try {
    const first = await login(f.base, f.store, cfg.owner, "sub-1");
    const inv = await invite(f, first.session!);
    const second = await login(f.base, f.store, "second@example.com", "sub-2", inv.token);
    for (const [session, title] of [
      [first.session, "from A"],
      [second.session, "from B"],
    ] as const)
      await f.call("/api/items", session, {
        method: "POST",
        body: JSON.stringify({
          ...defaultFields("2026-09-10"),
          title,
          public: true,
        }),
      });
    const share = await (
      await f.call("/api/share", first.session, {
        method: "POST",
        body: JSON.stringify({ action: "rotate" }),
      })
    ).json();
    const token = share.url.split("/").pop();
    const shared = (await (
      await f.call(
        `/api/items?from=2026-09-01&to=2026-10-01&share=${token}`,
      )
    ).json()) as { title: string }[];
    assert.deepEqual(
      shared.map((s) => s.title),
      ["from A"],
    );
  } finally {
    restore();
    await f.cleanup();
  }
});

test("Invite links are reusable by many accounts until revoked, and signup is refused without one", async () => {
  const restore = mockGoogle();
  const f = await fixture();
  try {
    const first = await login(f.base, f.store, cfg.owner, "sub-1");
    const inv = await invite(f, first.session!);
    const second = await login(f.base, f.store, "second@example.com", "sub-2", inv.token);
    assert.equal(second.status, 302);
    // The same invite link can be reused by a different new account too.
    const third = await login(f.base, f.store, "third@example.com", "sub-3", inv.token);
    assert.equal(third.status, 302);
    assert.equal(
      f.store.db.prepare("SELECT count(*) AS n FROM users").get()!.n,
      3,
    );
    const list = await (await f.call("/api/invites", first.session)).json();
    assert.equal(list.invites[0].usesCount, 2);
    // An unrelated account with no invite at all is refused, not silently signed up.
    const stranger = await login(f.base, f.store, "stranger@example.com", "sub-4");
    assert.equal(stranger.status, 403);
    // Revoking the invite stops any further new signups through it, but
    // does not affect the accounts that already joined via it.
    const revoke = await f.call(`/api/invites/${inv.id}/revoke`, first.session, {
      method: "POST",
      body: "{}",
    });
    assert.equal(revoke.status, 200);
    const fourth = await login(f.base, f.store, "fourth@example.com", "sub-5", inv.token);
    assert.equal(fourth.status, 403);
    assert.equal(
      f.store.db.prepare("SELECT count(*) AS n FROM users").get()!.n,
      3,
    );
  } finally {
    restore();
    await f.cleanup();
  }
});

test("Withdrawal preserves all owned data, revokes access and permits fresh invited registration", async () => {
  const restore = mockGoogle();
  const f = await fixture();
  try {
    const first = await login(f.base, f.store, cfg.owner, "withdraw-sub");
    const ownInvite = await invite(f, first.session!);
    const second = await login(f.base, f.store, "other@example.com", "other-sub", ownInvite.token);
    const otherInvite = await invite(f, second.session!);
    const user = f.store.userBySub("withdraw-sub")!;
    const item = f.store.create(user.id, { ...defaultFields(null), title: "retained", public: true });
    f.store.setUserShareHash(user.id, hash("old-share"));
    f.store.setUserPreferences(user.id, '{"durationMinutes":45}');
    f.store.db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(hash("other-device"), Date.now() + 60000, user.id);
    f.store.db.prepare("INSERT INTO subscriptions VALUES(?,?,?,?)").run("sub", "{}", 1, user.id);
    f.store.db.prepare("INSERT INTO deliveries VALUES(?,?,?,?,?,?)").run("delivery", 1, "sent", 1, 1, user.id);
    f.store.db.prepare("INSERT INTO trash VALUES(?,?,?,?,?)").run("trash", "old", 1, "{}", user.id);
    const key = "plan_agent_" + "k".repeat(43);
    f.store.db.prepare("INSERT INTO agent_keys VALUES(?,?,?,?,?,?,?,?,?,?,?)").run("key", "key", hash(key), '["items:read"]', user.email, user.googleSub, 1, Date.now() + 60000, null, null, user.id);
    f.store.db.prepare("INSERT INTO mcp_connections VALUES(?)").run("key");
    const grant = { keyId: "key", clientId: "client", resource: cfg.origin + "/mcp", scopes: ["items:read"] };
    f.store.db.prepare("INSERT INTO mcp_oauth VALUES(?,?,?,?)").run(hash("mcp-token"), "access", Date.now() + 60000, JSON.stringify(grant));
    f.store.db.prepare("INSERT INTO agent_audit VALUES(?,?,?,?,?,?)").run("audit", "key", "GET", "items", 200, 1);
    f.store.db.prepare("INSERT INTO agent_requests VALUES(?,?,?,?,?,?)").run("key", "request", "fingerprint", 200, "{}", 1);
    const post = (session?: string, body = { confirmation: "회원 탈퇴" }, headers = {}) => f.call("/api/account/withdraw", session, { method: "POST", body: JSON.stringify(body), headers });
    assert.equal((await post()).status, 401);
    assert.equal((await post(first.session, { confirmation: "" })).status, 400);
    assert.equal((await post(first.session, undefined, { Origin: "https://evil.example" })).status, 403);
    assert.equal((await post(first.session, undefined, { Authorization: `Bearer ${key}` })).status, 403);
    assert(f.store.user(user.id));
    const result = await post(first.session);
    assert.equal(result.status, 200);
    assert.match(result.headers.get("set-cookie")!, /plan_session=;/);
    assert.equal(f.store.user(user.id), undefined);
    assert.equal(f.store.userBySub("withdraw-sub"), undefined);
    assert.equal(f.store.userByShareHash(hash("old-share")), undefined);
    assert.deepEqual(f.store.items(user.id), []);
    assert.deepEqual(f.store.trash(user.id), []);
    for (const session of [first.session, "other-device"])
      assert.equal((await f.call("/api/preferences", session)).status, 401);
    assert.equal((await f.call("/api/items?from=2026-01-01&to=2026-02-01&share=old-share")).status, 404);
    assert.equal((await f.call(`/invite/${ownInvite.token}`)).status, 404);
    assert.equal((await f.call("/api/agent/v1/items?from=2026-01-01&to=2026-02-01", undefined, { headers: { Authorization: `Bearer ${key}` } })).status, 401);
    const { McpAuth } = await import("../src/server/mcp-auth.js");
    await assert.rejects(new McpAuth(f.store, cfg).verifyAccessToken("mcp-token"));
    assert.equal((await login(f.base, f.store, cfg.owner, "withdraw-sub")).status, 403);
    assert.equal((await login(f.base, f.store, cfg.owner, "withdraw-sub", ownInvite.token)).status, 403);
    const rejoined = await login(f.base, f.store, cfg.owner, "withdraw-sub", otherInvite.token);
    assert.equal(rejoined.status, 302);
    const fresh = f.store.userBySub("withdraw-sub")!;
    assert.notEqual(fresh.id, user.id);
    assert.deepEqual(f.store.items(fresh.id), []);
    assert.equal(fresh.preferences, null);
    assert.equal(fresh.shareHash, null);
    assert.equal((await f.call("/api/preferences", first.session)).status, 401);
    assert.equal((await f.call("/api/preferences", second.session)).status, 200);
    // Expired retained rows must survive the ordinary cleanup worker.
    f.store.db.prepare("UPDATE sessions SET expires=1 WHERE user_id=?").run(user.id);
    f.store.db.prepare("UPDATE mcp_oauth SET expires=1 WHERE id=?").run(hash("mcp-token"));
    f.store.cleanup();
    for (const table of ["items", "trash", "subscriptions", "deliveries", "agent_keys", "agent_audit", "agent_requests", "mcp_connections", "mcp_oauth"])
      assert.equal(f.store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n, 1, table);
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM sessions WHERE user_id=?").get(user.id)!.n, 2);
    assert.equal(JSON.parse(String(f.store.db.prepare("SELECT data FROM items WHERE id=?").get(item.id)!.data)).title, "retained");
    assert(f.store.db.prepare("SELECT deleted_at FROM users WHERE id=?").get(user.id)!.deleted_at);
    assert.deepEqual(f.store.db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    await f.cleanup();
    restore();
  }
});
