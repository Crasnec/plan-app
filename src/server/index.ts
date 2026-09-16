import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { Store } from "./store.js";
import { createApp } from "./app.js";
import { pushWorker } from "./push.js";
import { defaultFields, today, toUTC, addDays } from "../shared/domain.js";
process.umask(0o077);
const cfg = config();
const store = new Store(
  process.env.DATABASE_PATH ||
    (cfg.demo ? "data/demo.sqlite" : "data/plan.sqlite"),
);

// One-time migration from the old single-owner schema: fold whatever
// pre-existing global data there is into a first `users` row, tagged with
// the same identity the login gate used to enforce, so the current owner's
// session, calendar, keys and connections all keep working unchanged.
function backfillFirstUser() {
  if (store.db.prepare("SELECT 1 FROM users LIMIT 1").get()) return;
  const hasLegacyData = [
    "items",
    "sessions",
    "agent_keys",
    "subscriptions",
  ].some(
    (table) =>
      Number(store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n) >
      0,
  );
  if (!hasLegacyData) return;
  store.transaction(() => {
    const googleSub = store.setting("owner_sub") || randomUUID();
    const user = store.createUser(cfg.owner.toLowerCase(), googleSub);
    const shareHash = store.setting("share_hash");
    if (shareHash) store.setUserShareHash(user.id, shareHash);
    const prefs = store.setting("preferences");
    if (prefs) store.setUserPreferences(user.id, prefs);
    const historyVersion = Number(store.setting("history_version") || 0);
    if (historyVersion) store.setUserHistoryVersion(user.id, historyVersion);
    for (const table of [
      "items",
      "overrides",
      "trash",
      "sessions",
      "agent_keys",
      "subscriptions",
    ])
      store.db
        .prepare(`UPDATE ${table} SET user_id=? WHERE user_id IS NULL`)
        .run(user.id);
  });
}
backfillFirstUser();

if (cfg.demo && !store.db.prepare("SELECT 1 FROM users LIMIT 1").get()) {
  const demo = store.createUser("demo@localhost", "demo");
  store.create(demo.id, {
    ...defaultFields(today()),
    title: "가벼운 아침 산책",
    done: true,
    notes: "잠시 밖으로 나가 하루를 시작해요.",
  });
  store.create(demo.id, {
    ...defaultFields(today()),
    kind: "timed",
    title: "집중해서 프로젝트 정리",
    start: toUTC(`${today()}T10:00`),
    end: toUTC(`${today()}T11:30`),
    reminder: 10,
    public: true,
  });
  store.create(demo.id, {
    ...defaultFields(today()),
    kind: "timed",
    title: "책 읽는 시간",
    start: toUTC(`${today()}T11:00`),
    end: toUTC(`${today()}T12:00`),
    reminder: 10,
  });
  store.create(demo.id, {
    ...defaultFields(addDays(today(), 2)),
    title: "주말 장보기",
    public: true,
  });
  store.create(demo.id, { ...defaultFields(null), title: "다음 여행 계획하기" });
}
const { app, close } = createApp(store, cfg);
const worker = pushWorker(store, cfg);
const port = Number(process.env.PORT || 3000);
const server = app.listen(port, cfg.demo ? "127.0.0.1" : "0.0.0.0", () =>
  console.log(
    `Plan listening on port ${port}${cfg.demo ? " (local demo)" : ""}`,
  ),
);
void worker.tick().catch(() => console.error("Notification scheduler failed"));
function shutdown() {
  worker.stop();
  close();
  server.close(() => {
    store.db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
