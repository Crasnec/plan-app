import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/server/store.js";
import { createApp } from "../src/server/app.js";
import { hash } from "../src/server/auth.js";
import { defaultFields, DAY } from "../src/shared/domain.js";
import type { Config } from "../src/server/config.js";
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
  store.set("owner_sub", "test-google-sub");
  store.db
    .prepare("INSERT INTO sessions VALUES(?,?)")
    .run(hash("owner-session"), Date.now() + 60000);
  const { app, close } = createApp(store, cfg);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  async function call(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      token?: string;
      session?: boolean;
      idempotency?: string;
      origin?: string;
    } = {},
  ) {
    const res = await fetch(origin + path, {
      method: options.method || "GET",
      headers: {
        ...(options.body !== undefined
          ? { "Content-Type": "application/json" }
          : {}),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        ...(options.session
          ? { Cookie: "plan_session=owner-session", Origin: cfg.origin }
          : {}),
        ...(options.idempotency
          ? { "Idempotency-Key": options.idempotency }
          : {}),
        ...(options.origin ? { Origin: options.origin } : {}),
      },
      ...(options.body !== undefined
        ? { body: JSON.stringify(options.body) }
        : {}),
    });
    return { status: res.status, headers: res.headers, data: await res.json() };
  }
  async function issue(
    scopes = ["items:read"],
    extra: Record<string, unknown> = {},
  ) {
    const r = await call("/api/agent-keys", {
      method: "POST",
      session: true,
      body: { name: "test agent", scopes, ...extra },
    });
    assert.equal(r.status, 201);
    return r.data as {
      id: string;
      token: string;
      scopes: string[];
      expiresAt: string;
    };
  }
  return {
    store,
    call,
    issue,
    cleanup: async () => {
      close();
      await new Promise<void>((r) => server.close(() => r()));
      store.db.close();
    },
  };
}
const base = "/api/agent/v1";
test("keys are returned once, hashed at rest; key management is session-only", async () => {
  const f = await fixture();
  try {
    assert.equal(
      (
        await f.call("/api/agent-keys", {
          method: "POST",
          body: { name: "x", scopes: ["items:read"] },
          origin: cfg.origin,
        })
      ).status,
      401,
    );
    const k = await f.issue();
    assert.match(k.token, /^plan_agent_[A-Za-z0-9_-]{43}$/);
    const row = f.store.db
      .prepare("SELECT * FROM agent_keys WHERE id=?")
      .get(k.id)!;
    assert.equal(row.token_hash, hash(k.token));
    assert(!JSON.stringify(row).includes(k.token));
    const list = await f.call("/api/agent-keys", { session: true });
    assert.equal(list.status, 200);
    assert(!JSON.stringify(list.data).includes(k.token));
    assert(!JSON.stringify(list.data).includes(hash(k.token)));
    assert.equal(
      (await f.call("/api/agent-keys", { token: k.token, session: true }))
        .status,
      403,
    );
    assert.equal(
      (await f.call(`${base}/agent-keys`, { token: k.token })).status,
      404,
    );
    assert.equal(
      (
        await f.call("/api/share", {
          method: "POST",
          body: { action: "rotate" },
          token: k.token,
          origin: cfg.origin,
        })
      ).status,
      401,
    );
  } finally {
    await f.cleanup();
  }
});
test("read key reads private entries but cannot create, patch, delete or restore", async () => {
  const f = await fixture();
  try {
    const k = await f.issue(),
      item = f.store.create({
        ...defaultFields("2026-09-10"),
        title: "private",
      });
    const list = await f.call(`${base}/items?from=2026-09-01&to=2026-10-01`, {
      token: k.token,
    });
    assert.equal(list.status, 200);
    assert.equal(list.data.items[0].public, false);
    for (const [method, path, body] of [
      ["POST", "/items", { ...defaultFields(), title: "no" }],
      [
        "PATCH",
        `/items/${item.id}`,
        { key: "single", version: 1, scope: "one", changes: { title: "no" } },
      ],
      [
        "DELETE",
        `/items/${item.id}`,
        { key: "single", version: 1, scope: "one" },
      ],
      ["POST", "/trash/not-found/restore", {}],
    ] as const)
      assert.equal(
        (
          await f.call(base + path, {
            method,
            body,
            token: k.token,
            idempotency: "test-operation",
          })
        ).status,
        403,
      );
    assert.equal(f.store.item(item.id).title, "private");
  } finally {
    await f.cleanup();
  }
});
test("API requires a bearer even with valid owner cookie; no query token or cross-origin fallback", async () => {
  const f = await fixture();
  try {
    const k = await f.issue();
    assert.equal((await f.call(`${base}/me`, { session: true })).status, 401);
    assert.equal((await f.call(`${base}/me?api_key=${k.token}`)).status, 401);
    assert.equal(
      (await f.call(`${base}/me?api_key=secret`, { token: k.token })).status,
      400,
    );
    assert.equal(
      (
        await f.call(`${base}/me`, {
          token: k.token,
          origin: "https://evil.example",
        })
      ).status,
      403,
    );
    assert.equal((await f.call(`${base}/me`, { token: k.token })).status, 200);
  } finally {
    await f.cleanup();
  }
});
test("expiry, revocation and owner identity changes invalidate keys immediately", async () => {
  const f = await fixture();
  try {
    const k = await f.issue();
    f.store.db
      .prepare("UPDATE agent_keys SET expires_at=? WHERE id=?")
      .run(Date.now() - 1, k.id);
    assert.equal((await f.call(`${base}/me`, { token: k.token })).status, 401);
    const k2 = await f.issue();
    await f.call(`/api/agent-keys/${k2.id}/revoke`, {
      method: "POST",
      session: true,
      body: {},
    });
    assert.equal((await f.call(`${base}/me`, { token: k2.token })).status, 401);
    const k3 = await f.issue();
    f.store.set("owner_sub", "different-google-sub");
    assert.equal((await f.call(`${base}/me`, { token: k3.token })).status, 401);
  } finally {
    await f.cleanup();
  }
});
test("idempotent create replays once, validates fingerprint, and checks authorization before replay", async () => {
  const f = await fixture();
  try {
    const k = await f.issue(["items:read", "items:write"]);
    const fields = { ...defaultFields("2026-09-10"), title: "once" };
    const args = {
      method: "POST",
      body: fields,
      token: k.token,
      idempotency: "create-calendar-01",
    };
    const first = await f.call(`${base}/items`, args);
    assert.equal(first.status, 201);
    const replay = await f.call(`${base}/items`, {
      ...args,
      body: Object.fromEntries(Object.entries(fields).reverse()),
    });
    assert.equal(replay.status, 201);
    assert.equal(replay.headers.get("Idempotency-Replayed"), "true");
    assert.equal(first.data.item.id, replay.data.item.id);
    assert.equal(f.store.items().length, 1);
    assert.equal(
      (
        await f.call(`${base}/items`, {
          ...args,
          body: { ...fields, title: "different" },
        })
      ).status,
      409,
    );
    await f.call(`/api/agent-keys/${k.id}/revoke`, {
      method: "POST",
      session: true,
      body: {},
    });
    assert.equal((await f.call(`${base}/items`, args)).status, 401);
  } finally {
    await f.cleanup();
  }
});
test("write key updates with version checks; deletion requires its own scope", async () => {
  const f = await fixture();
  try {
    const k = await f.issue(["items:read", "items:write"]);
    const i = f.store.create({ ...defaultFields(), title: "original" });
    const body = {
      key: "single",
      version: 1,
      scope: "one",
      changes: { title: "updated" },
    };
    assert.equal(
      (
        await f.call(`${base}/items/${i.id}`, {
          method: "PATCH",
          token: k.token,
          idempotency: "patch-item-01",
          body,
        })
      ).status,
      200,
    );
    assert.equal(f.store.item(i.id).version, 2);
    assert.equal(
      (
        await f.call(`${base}/items/${i.id}`, {
          method: "PATCH",
          token: k.token,
          idempotency: "patch-item-02",
          body,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await f.call(`${base}/items/${i.id}`, {
          method: "DELETE",
          token: k.token,
          idempotency: "delete-item-01",
          body: { key: "single", version: 2, scope: "one" },
        })
      ).status,
      403,
    );
    const deleter = await f.issue(["items:read", "items:delete"]);
    assert.equal(
      (
        await f.call(`${base}/items/${i.id}`, {
          method: "DELETE",
          token: deleter.token,
          idempotency: "delete-item-01",
          body: { key: "single", version: 2, scope: "one" },
        })
      ).status,
      200,
    );
    const trash = await f.call(`${base}/trash`, { token: k.token });
    assert.equal(trash.data.items.length, 1);
    assert.equal(
      (
        await f.call(`${base}/trash/${trash.data.items[0].id}/restore`, {
          method: "POST",
          token: k.token,
          idempotency: "restore-item-01",
          body: {},
        })
      ).status,
      200,
    );
    assert.equal(f.store.item(i.id).deletedAt, null);
  } finally {
    await f.cleanup();
  }
});
test("mutation rejects absent idempotency, bad scopes, unknown fields and invalid date range", async () => {
  const f = await fixture();
  try {
    assert.equal(
      (
        await f.call("/api/agent-keys", {
          method: "POST",
          session: true,
          body: { name: "bad", scopes: ["admin"] },
        })
      ).status,
      400,
    );
    const k = await f.issue(["items:read", "items:write"]);
    const item = f.store.create({ ...defaultFields(), title: "test" });
    assert.equal(
      (
        await f.call(`${base}/items`, {
          method: "POST",
          token: k.token,
          body: { ...defaultFields(), title: "x" },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await f.call(`${base}/items/${item.id}`, {
          method: "PATCH",
          token: k.token,
          idempotency: "unknown-field-01",
          body: {
            key: "single",
            version: 1,
            scope: "all",
            changes: { version: 100 },
          },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await f.call(`${base}/items?from=2026-01-01&to=2027-01-01`, {
          token: k.token,
        })
      ).status,
      400,
    );
    assert.equal(f.store.item(item.id).version, 1);
  } finally {
    await f.cleanup();
  }
});
test("pagination and OpenAPI contract are available; audit contains no credential or content", async () => {
  const f = await fixture();
  try {
    const k = await f.issue(["items:read", "items:write"]);
    for (let n = 0; n < 3; n++)
      f.store.create({
        ...defaultFields("2026-09-10"),
        title: `confidential-${n}`,
      });
    const list = await f.call(
      `${base}/items?from=2026-09-01&to=2026-10-01&limit=2`,
      { token: k.token },
    );
    assert.equal(list.data.items.length, 2);
    assert.equal(list.data.nextOffset, 2);
    const last = await f.call(
      `${base}/items?from=2026-09-01&to=2026-10-01&limit=2&offset=2`,
      { token: k.token },
    );
    assert.equal(last.data.items.length, 1);
    assert.equal(last.data.nextOffset, null);
    const schema = await f.call(`${base}/openapi.json`, { token: k.token });
    assert.equal(schema.data.openapi, "3.1.0");
    assert(schema.data.paths["/items/{id}"].patch);
    const audit = await f.call("/api/agent-keys/audit", { session: true });
    assert(audit.data.events.length >= 3);
    assert(!JSON.stringify(audit.data).includes(k.token));
    assert(!JSON.stringify(audit.data).includes("confidential"));
  } finally {
    await f.cleanup();
  }
});
test("per-key rate limit returns 429 and Retry-After", async () => {
  const f = await fixture();
  try {
    const k = await f.issue();
    let last;
    for (let i = 0; i < 121; i++)
      last = await f.call(`${base}/me`, { token: k.token });
    assert.equal(last!.status, 429);
    assert(Number(last!.headers.get("Retry-After")) > 0);
  } finally {
    await f.cleanup();
  }
});
test("failed mutation rolls back data and replay record together", async () => {
  const f = await fixture();
  try {
    const k = await f.issue(["items:read", "items:write"]);
    f.store.db.exec(
      "CREATE TRIGGER fail_receipt BEFORE INSERT ON agent_requests BEGIN SELECT RAISE(ABORT,'simulated receipt failure'); END;",
    );
    const result = await f.call(`${base}/items`, {
      method: "POST",
      token: k.token,
      idempotency: "atomic-create-01",
      body: { ...defaultFields(), title: "must rollback" },
    });
    assert.equal(result.status, 500);
    assert.equal(f.store.items().length, 0);
    assert.equal(
      f.store.db.prepare("SELECT count(*) AS n FROM agent_requests").get()!.n,
      0,
    );
  } finally {
    await f.cleanup();
  }
});
