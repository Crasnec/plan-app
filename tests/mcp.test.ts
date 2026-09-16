import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createApp } from "../src/server/app.js";
import { Store } from "../src/server/store.js";
import { hash } from "../src/server/auth.js";
import type { Config } from "../src/server/config.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
const callback = "https://chatgpt.com/connector/oauth/test-client";
async function fixture(path = ":memory:") {
  const store = new Store(path);
  const user = store.createUser(cfg.owner, "google-owner");
  store.db
    .prepare("INSERT INTO sessions VALUES(?,?,?)")
    .run(hash("session"), Date.now() + 600000, user.id);
  const { app, close } = createApp(store, cfg);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = (path: string, init: RequestInit = {}) =>
    fetch(base + path, { ...init, redirect: "manual" });
  const form = (path: string, body: URLSearchParams) =>
    request(path, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  async function start(scopes = "items:read items:write items:delete") {
    const register = await request("/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "ChatGPT test",
        redirect_uris: [callback],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    });
    assert.equal(register.status, 201, await register.clone().text());
    const client = await register.json();
    const verifier = randomBytes(32).toString("base64url");
    const params = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: callback,
      response_type: "code",
      scope: scopes,
      state: "test-state",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      resource: `${cfg.origin}/mcp`,
    });
    const auth = await request(`/authorize?${params}`);
    assert.equal(auth.status, 302);
    const location = auth.headers.get("location")!;
    assert(location.startsWith("/mcp/connect?ticket="), location);
    const html = await (
      await request(location, { headers: { Cookie: "plan_session=session" } })
    ).text();
    const csrf = html.match(/name="csrf" value="([A-Za-z0-9_-]+)"/)?.[1];
    assert(csrf, html);
    const ticket = new URL(location, base).searchParams.get("ticket")!;
    return { client, verifier, ticket, csrf, params };
  }
  async function approve(
    flow: Awaited<ReturnType<typeof start>>,
    rights = ["items:write", "items:delete"],
  ) {
    const body = new URLSearchParams({
      ticket: flow.ticket,
      csrf: flow.csrf,
      decision: "approve",
    });
    rights.forEach((scope) => body.append("scope", scope));
    const approval = await request("/mcp/connect", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: "plan_session=session",
        Origin: cfg.origin,
      },
      body,
    });
    assert.equal(approval.status, 200, await approval.clone().text());
    const html = await approval.text();
    const target = html.match(/content="0;url=([^"]+)"/)?.[1];
    assert(target, html);
    const redirect = new URL(target.replace(/&amp;/g, "&"));
    assert.equal(redirect.searchParams.get("state"), "test-state");
    const code = redirect.searchParams.get("code")!;
    return { ...flow, code };
  }
  const exchange = (
    flow: Awaited<ReturnType<typeof approve>>,
    extra: Record<string, string> = {},
  ) =>
    form(
      "/token",
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: flow.client.client_id,
        code: flow.code,
        code_verifier: flow.verifier,
        redirect_uri: callback,
        resource: `${cfg.origin}/mcp`,
        ...extra,
      }),
    );
  async function connect(rights = ["items:write", "items:delete"]) {
    const flow = await approve(await start(), rights);
    const response = await exchange(flow);
    assert.equal(response.status, 200, await response.clone().text());
    return { flow, tokens: await response.json() };
  }
  const rpc = (access: string, method: string, params: unknown = {}) =>
    request("/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${access}`,
        "MCP-Protocol-Version": "2025-11-25",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
  async function call(access: string, name: string, args: unknown = {}) {
    const response = await rpc(access, "tools/call", { name, arguments: args });
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json();
    assert(body.result, JSON.stringify(body));
    return body.result;
  }
  return {
    base,
    store,
    user,
    request,
    form,
    start,
    approve,
    exchange,
    connect,
    rpc,
    call,
    cleanup: async () => {
      close();
      await new Promise<void>((r) => server.close(() => r()));
      store.db.close();
    },
  };
}
test("MCP OAuth discovery, login/consent, PKCE, resource binding, code replay and client validation", async () => {
  const f = await fixture();
  try {
    const unauth = await f.request("/mcp");
    assert.equal(unauth.status, 401);
    assert.match(
      unauth.headers.get("www-authenticate")!,
      /oauth-protected-resource\/mcp/,
    );
    assert.equal(
      (
        await (
          await f.request("/.well-known/oauth-protected-resource/mcp")
        ).json()
      ).resource,
      `${cfg.origin}/mcp`,
    );
    const metadata = await (
      await f.request("/.well-known/oauth-authorization-server")
    ).json();
    assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
    assert.deepEqual(metadata.token_endpoint_auth_methods_supported, ["none"]);
    const badClient = await f.request("/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["https://evil.example/callback"],
        token_endpoint_auth_method: "none",
      }),
    });
    assert.equal(badClient.status, 400);
    const started = await f.start();
    assert.match(
      await (await f.request(`/mcp/connect?ticket=${started.ticket}`)).text(),
      /Google로 로그인/,
    );
    const csrf = await f.request("/mcp/connect", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: cfg.origin,
        Cookie: "plan_session=session",
      },
      body: new URLSearchParams({
        ticket: started.ticket,
        csrf: "bad",
        decision: "approve",
      }),
    });
    assert.equal(csrf.status, 403);
    const flow = await f.approve(started);
    assert.equal(
      (
        await f.exchange(flow, {
          code_verifier: randomBytes(32).toString("base64url"),
        })
      ).status,
      400,
    );
    assert.equal(
      (await f.exchange(flow, { resource: "https://evil.example/mcp" })).status,
      400,
    );
    const response = await f.exchange(flow);
    assert.equal(response.status, 200);
    const tokens = await response.json();
    assert.equal((await f.exchange(flow)).status, 400);
    const init = await (
      await f.rpc(tokens.access_token, "initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      })
    ).json();
    assert.equal(init.result.serverInfo.name, "haru-plan");
    const disk = JSON.stringify(
      f.store.db.prepare("SELECT * FROM mcp_oauth").all(),
    );
    assert(!disk.includes(tokens.access_token));
    assert(!disk.includes(tokens.refresh_token));
  } finally {
    await f.cleanup();
  }
});
test("MCP tools use KST, defaults, strict schemas, idempotency, version checks and reversible deletion", async () => {
  const f = await fixture();
  try {
    const { tokens } = await f.connect();
    const access = tokens.access_token;
    const tools = (await (await f.rpc(access, "tools/list")).json()).result
      .tools;
    assert.equal(tools.length, 8);
    assert.equal(
      tools.find((t: { name: string }) => t.name === "plan_delete").annotations
        .destructiveHint,
      true,
    );
    f.store.setUserPreferences(
      f.user.id,
      JSON.stringify({
        durationMinutes: 45,
        showCompleted: false,
        publicByDefault: true,
        applyToApi: true,
      }),
    );
    const args = {
      title: "MCP 테스트",
      kind: "timed",
      start: "2026-09-14T09:00",
      operationId: "create-mcp-001",
    };
    const created = await f.call(access, "plan_create", args);
    assert(!created.isError, JSON.stringify(created));
    const item = created.structuredContent.item;
    assert.equal(item.start, "2026-09-14T00:00:00.000Z");
    assert.equal(item.end, "2026-09-14T00:45:00.000Z");
    assert.equal(item.public, true);
    assert.deepEqual(await f.call(access, "plan_create", args), created);
    assert.equal(
      (await f.call(access, "plan_create", { ...args, title: "different" }))
        .isError,
      true,
    );
    const list = await f.call(access, "plan_list", {
      from: "2026-09-14",
      to: "2026-09-15",
    });
    assert.equal(list.structuredContent.items[0].startKst, "2026-09-14T09:00");
    const identity = {
      itemId: item.id,
      key: "single",
      version: item.version,
      scope: "one",
      operationId: "complete-mcp-001",
    };
    const completed = await f.call(access, "plan_complete", {
      ...identity,
      done: true,
    });
    assert.equal(completed.structuredContent.item.done, true);
    assert.equal(
      (
        await f.call(access, "plan_update", {
          ...identity,
          operationId: "stale-update-001",
          changes: { title: "stale" },
        })
      ).isError,
      true,
    );
    assert.equal(
      (
        await f.call(access, "plan_update", {
          ...identity,
          operationId: "invalid-update-001",
          changes: { unknown: true },
        })
      ).isError,
      true,
    );
    assert.equal(
      (
        await f.call(access, "plan_delete", {
          ...identity,
          version: completed.structuredContent.item.version,
          operationId: "delete-mcp-001",
        })
      ).isError,
      undefined,
    );
    const trash = await f.call(access, "plan_trash");
    assert.equal(
      (
        await f.call(access, "plan_restore", {
          trashId: trash.structuredContent.items[0].id,
          operationId: "restore-mcp-001",
        })
      ).isError,
      undefined,
    );
    assert.equal(f.store.item(item.id, f.user.id).deletedAt, null);
    const audit = JSON.stringify(
      f.store.db.prepare("SELECT * FROM agent_audit").all(),
    );
    assert(!audit.includes("MCP 테스트"));
    assert(!audit.includes(access));
  } finally {
    await f.cleanup();
  }
});
test("MCP read-only grants cannot write; refresh rotation and UI revocation invalidate access", async () => {
  const f = await fixture();
  try {
    const { flow, tokens } = await f.connect([]);
    assert.equal(
      (await f.call(tokens.access_token, "plan_context")).isError,
      undefined,
    );
    const denied = await f.call(tokens.access_token, "plan_create", {
      title: "no",
      kind: "undated",
      operationId: "denied-create",
    });
    assert.equal(denied.isError, true);
    assert(denied._meta["mcp/www_authenticate"]);
    const refresh = (raw: string) =>
      f.form(
        "/token",
        new URLSearchParams({
          grant_type: "refresh_token",
          client_id: flow.client.client_id,
          refresh_token: raw,
          resource: `${cfg.origin}/mcp`,
        }),
      );
    const response = await refresh(tokens.refresh_token);
    assert.equal(response.status, 200);
    const next = await response.json();
    assert.equal((await refresh(tokens.refresh_token)).status, 400);
    assert.equal((await f.rpc(next.access_token, "tools/list")).status, 401);
    const other = await f.connect();
    f.store.db.prepare("UPDATE agent_keys SET revoked_at=?").run(Date.now());
    assert.equal(
      (await f.rpc(other.tokens.access_token, "tools/list")).status,
      401,
    );
  } finally {
    await f.cleanup();
  }
});
test("Official MCP client completes the Streamable HTTP lifecycle", async () => {
  const f = await fixture();
  const client = new Client({ name: "integration-test", version: "1" });
  try {
    const { tokens } = await f.connect([]);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${f.base}/mcp`), {
        requestInit: {
          headers: { Authorization: `Bearer ${tokens.access_token}` },
        },
      }),
    );
    assert.equal((await client.listTools()).tools.length, 8);
    const result = await client.callTool({
      name: "plan_context",
      arguments: {},
    });
    assert.equal(result.isError, undefined);
  } finally {
    await client.close();
    await f.cleanup();
  }
});
test("MCP connections remain renewable after 45 days and explicit revocation ends access", async () => {
  const f = await fixture();
  const realNow = Date.now;
  try {
    const { flow, tokens } = await f.connect();
    const metadata = await (
      await f.request("/api/agent-keys", {
        headers: { Cookie: "plan_session=session" },
      })
    ).json();
    const connection = metadata.keys.find(
      (key: { kind: string }) => key.kind === "mcp",
    );
    assert.equal(connection.expiresAt, null);
    Date.now = () => realNow() + 45 * 86400000;
    assert.equal((await f.rpc(tokens.access_token, "tools/list")).status, 401);
    const refreshBody = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: flow.client.client_id,
      refresh_token: tokens.refresh_token,
      resource: `${cfg.origin}/mcp`,
    });
    const renewed = await f.form("/token", refreshBody);
    assert.equal(renewed.status, 200);
    const next = await renewed.json();
    assert.equal((await f.rpc(next.access_token, "tools/list")).status, 200);
    f.store.db.prepare("UPDATE sessions SET expires=?").run(Date.now() + 60000);
    const revoke = await f.request(`/api/agent-keys/${connection.id}/revoke`, {
      method: "POST",
      headers: {
        Cookie: "plan_session=session",
        Origin: cfg.origin,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    assert.equal(revoke.status, 200);
    assert.equal((await f.rpc(next.access_token, "tools/list")).status, 401);
    refreshBody.set("refresh_token", next.refresh_token);
    assert.equal((await f.form("/token", refreshBody)).status, 400);
  } finally {
    Date.now = realNow;
    await f.cleanup();
  }
});
test("Migration extends only active MCP grants and preserves ordinary API key expiry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "plan-mcp-migrate-"));
  const path = join(dir, "plan.sqlite");
  const f = await fixture(path);
  const legacyExpiry = Date.now() + 30 * 86400000;
  try {
    await f.connect();
    const revoked = await f.connect();
    const grant = JSON.parse(
      f.store.db
        .prepare("SELECT data FROM mcp_oauth WHERE id=?")
        .get(hash(revoked.tokens.access_token))!.data as string,
    );
    f.store.db
      .prepare("UPDATE agent_keys SET revoked_at=? WHERE id=?")
      .run(Date.now(), grant.keyId);
    f.store.db.prepare("UPDATE agent_keys SET expires_at=?").run(legacyExpiry);
    f.store.db
      .prepare(
        "UPDATE mcp_oauth SET expires=? WHERE kind IN ('refresh','used_refresh')",
      )
      .run(legacyExpiry);
    f.store.db
      .prepare("INSERT INTO agent_keys VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run(
        "api-only",
        "ordinary",
        hash("api-only-secret"),
        '["items:read"]',
        cfg.owner,
        "google-owner",
        Date.now(),
        legacyExpiry,
        null,
        null,
        f.user.id,
      );
    f.store.db.exec(
      "DELETE FROM mcp_connections; DELETE FROM migrations WHERE version=5",
    );
  } finally {
    await f.cleanup();
  }
  const migrated = new Store(path);
  try {
    assert.equal(
      migrated.db.prepare("SELECT count(*) AS n FROM mcp_connections").get()!.n,
      1,
    );
    assert.equal(
      migrated.db
        .prepare("SELECT expires_at FROM agent_keys WHERE id='api-only'")
        .get()!.expires_at,
      legacyExpiry,
    );
    assert.equal(
      migrated.db
        .prepare(
          "SELECT count(*) AS n FROM agent_keys WHERE revoked_at IS NOT NULL",
        )
        .get()!.n,
      1,
    );
    assert(
      Number(
        migrated.db
          .prepare(
            "SELECT max(expires) AS expiry FROM mcp_oauth WHERE kind='refresh'",
          )
          .get()!.expiry,
      ) >
        Date.now() + 100 * 365 * 86400000,
    );
  } finally {
    migrated.db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
