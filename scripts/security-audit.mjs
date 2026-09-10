// Bounded local probes only. Uses synthetic records and OAuth identifiers; no live account access.
import { build } from "esbuild";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
await build({
  entryPoints: ["src/server/app.ts", "src/server/store.ts"],
  outdir: "dist/audit",
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
});
const { createApp } = await import("../dist/audit/app.js");
const { Store } = await import("../dist/audit/store.js");
const results = [];
const cfg = {
  origin: "http://localhost:3000",
  owner: "crasnec@gmail.com",
  clientId: "audit-client",
  clientSecret: "audit-placeholder",
  vapidPublic: "",
  vapidPrivate: "",
  vapidSubject: "mailto:crasnec@gmail.com",
  demo: false,
  production: false,
};
const directory = await mkdtemp(join(tmpdir(), "plan-security-audit-"));
const store = new Store(join(directory, "plan.sqlite"));
const { app, close } = createApp(store, cfg);
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve, reject) => {
  server.once("listening", resolve);
  server.once("error", reject);
});
const origin = `http://127.0.0.1:${server.address().port}`;
const hash = (s) => createHash("sha256").update(s).digest("hex");
try {
  // Bounded regression probe: five starts succeed, excess requests are limited.
  const statuses = [];
  for (let i = 0; i < 8; i++)
    statuses.push(
      (await fetch(`${origin}/auth/google`, { redirect: "manual" })).status,
    );
  results.push({
    id: "AUD-01",
    probe: "unauthenticated OAuth start allocation",
    requests: 8,
    statuses,
    oauthRows: store.db.prepare("SELECT count(*) AS n FROM oauth").get().n,
  });
  const response = await fetch(
    `${origin}/auth/google/callback?code=invalid&state=${encodeURIComponent("é".repeat(43))}`,
    { headers: { Cookie: `plan_oauth=${"a".repeat(43)}` } },
  );
  results.push({
    id: "AUD-02",
    probe: "non-ASCII OAuth state with same JS length",
    status: response.status,
    body: await response.json(),
  });
  store.db
    .prepare("INSERT INTO sessions VALUES(?,?)")
    .run(hash("audit-session"), Date.now() + 60000);
  store.db
    .prepare("INSERT INTO sessions VALUES(?,?)")
    .run(hash("second-session"), Date.now() + 60000);
  const stream = await fetch(`${origin}/api/events`, {
    headers: { Cookie: "plan_session=audit-session" },
  });
  const reader = stream.body.getReader();
  await reader.read();
  await fetch(`${origin}/api/logout`, {
    method: "POST",
    headers: {
      Cookie: "plan_session=audit-session",
      Origin: cfg.origin,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  await fetch(`${origin}/api/items`, {
    method: "POST",
    headers: {
      Cookie: "plan_session=second-session",
      Origin: cfg.origin,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      title: "audit synthetic item",
      notes: "",
      kind: "undated",
      start: null,
      end: null,
      public: false,
      done: false,
      reminder: null,
      rule: null,
    }),
  });
  const update = await Promise.race([
    reader.read(),
    new Promise((resolve) => setTimeout(() => resolve(null), 1500)),
  ]);
  results.push({
    id: "AUD-03",
    probe: "SSE after logout",
    closed: update?.done === true,
    received: update?.value ? new TextDecoder().decode(update.value) : null,
  });
  await reader.cancel();
  const mask = process.umask(0o022);
  let backup;
  try {
    backup = spawnSync(process.execPath, ["scripts/backup.mjs"], {
      env: {
        ...process.env,
        DATABASE_PATH: join(directory, "plan.sqlite"),
        BACKUP_DIR: join(directory, "backups"),
      },
      encoding: "utf8",
    });
  } finally {
    process.umask(mask);
  }
  const file = backup.stdout?.match(/Verified backup: (.+)/)?.[1];
  results.push({
    id: "AUD-04",
    probe: "backup permissions under standard umask 022",
    exit: backup.status,
    fileMode: file ? ((await stat(file)).mode & 0o777).toString(8) : null,
    directoryMode: (
      (await stat(join(directory, "backups"))).mode & 0o777
    ).toString(8),
  });
  await mkdir("artifacts", { recursive: true });
  await writeFile(
    "artifacts/security-audit.json",
    JSON.stringify(results, null, 2) + "\n",
  );
  console.log(JSON.stringify(results, null, 2));
  assert.deepEqual(statuses, [302, 302, 302, 302, 302, 429, 429, 429]);
  assert.equal(results[0].oauthRows, 5);
  assert.equal(results[1].status, 400);
  assert.equal(results[2].closed, true);
  assert.equal(results[2].received, null);
  assert.equal(results[3].exit, 0);
  assert.equal(results[3].fileMode, "600");
  assert.equal(results[3].directoryMode, "700");
} finally {
  close();
  await new Promise((resolve) => server.close(resolve));
  store.db.close();
  await rm(directory, { recursive: true, force: true });
}
