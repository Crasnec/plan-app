import test from "node:test";
import assert from "node:assert/strict";
import { OAuth2Client } from "google-auth-library";
import { createApp } from "../src/server/app.js";
import { Store } from "../src/server/store.js";
import { hash } from "../src/server/auth.js";
import { errorPage } from "../src/server/error-page.js";

test("Browser errors are HTML; API and JSON clients keep JSON; denied OAuth account gets 403 page", async () => {
  const store = new Store(":memory:");
  const { app, close } = createApp(store, {
    origin: "http://localhost:3000",
    owner: "owner@example.com",
    clientId: "",
    clientSecret: "",
    vapidPublic: "",
    vapidPrivate: "",
    vapidSubject: "mailto:owner@example.com",
    demo: false,
    production: false,
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const originalGet = OAuth2Client.prototype.getToken;
  const originalVerify = OAuth2Client.prototype.verifyIdToken;
  try {
    for (const [path, status] of [
      ["/auth/google", 503],
      ["/auth/google/callback?state=%3Cscript%3E", 400],
      ["/missing-page", 404],
    ] as const) {
      const r = await fetch(base + path, { headers: { Accept: "text/html" } });
      assert.equal(r.status, status);
      assert.match(r.headers.get("content-type")!, /text\/html/);
      const body = await r.text();
      assert.match(body, /홈으로 돌아가기/);
      assert.doesNotMatch(body, /<script>|owner@example/);
      assert.equal(r.headers.get("cache-control"), "no-store");
    }
    for (const accept of ["text/html", "application/json"]) {
      const r = await fetch(base + "/api/items?from=2026-09-01&to=2026-10-01", {
        headers: { Accept: accept },
      });
      assert.equal(r.status, 401);
      assert.match(r.headers.get("content-type")!, /application\/json/);
      assert.equal(typeof (await r.json()).error, "string");
    }
    const json = await fetch(base + "/auth/google/callback", {
      headers: { Accept: "application/json" },
    });
    assert.equal(json.status, 400);
    assert.equal(typeof (await json.json()).error, "string");
    // Mock only Google's network boundary; exercise actual state, nonce and owner checks.
    OAuth2Client.prototype.getToken = (async () => ({
      tokens: { id_token: "test-only" },
    })) as unknown as typeof originalGet;
    OAuth2Client.prototype.verifyIdToken = (async () => ({
      getPayload: () => ({
        email: "visitor@example.com",
        email_verified: true,
        sub: "visitor",
        nonce: "test-nonce",
      }),
    })) as unknown as typeof originalVerify;
    const state = "a".repeat(43);
    store.db
      .prepare("INSERT INTO oauth VALUES(?,?,?)")
      .run(
        hash(state),
        Date.now() + 60000,
        JSON.stringify({ nonce: "test-nonce", verifier: "test-verifier" }),
      );
    const denied = await fetch(
      `${base}/auth/google/callback?state=${state}&code=test`,
      { headers: { Accept: "text/html", Cookie: `plan_oauth=${state}` } },
    );
    assert.equal(denied.status, 403);
    const body = await denied.text();
    assert.match(body, /편집 권한이 없는 계정/);
    assert.match(body, /다른 계정으로 로그인/);
    assert.doesNotMatch(body, /visitor@example|test-nonce|test-verifier/);
    assert.equal(
      store.db.prepare("SELECT count(*) AS n FROM sessions").get()!.n,
      0,
    );
    for (const status of [400, 401, 403, 404, 413, 429, 500, 503]) {
      assert.match(errorPage(status), /lang="ko"/);
      assert.match(errorPage(status), new RegExp(`>${status}<`));
    }
  } finally {
    OAuth2Client.prototype.getToken = originalGet;
    OAuth2Client.prototype.verifyIdToken = originalVerify;
    close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.db.close();
  }
});
