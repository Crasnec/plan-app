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
if (cfg.demo && !store.items().length) {
  store.create({
    ...defaultFields(today()),
    title: "가벼운 아침 산책",
    done: true,
    notes: "잠시 밖으로 나가 하루를 시작해요.",
  });
  store.create({
    ...defaultFields(today()),
    kind: "timed",
    title: "집중해서 프로젝트 정리",
    start: toUTC(`${today()}T10:00`),
    end: toUTC(`${today()}T11:30`),
    reminder: 10,
    public: true,
  });
  store.create({
    ...defaultFields(today()),
    kind: "timed",
    title: "책 읽는 시간",
    start: toUTC(`${today()}T11:00`),
    end: toUTC(`${today()}T12:00`),
    reminder: 10,
  });
  store.create({
    ...defaultFields(addDays(today(), 2)),
    title: "주말 장보기",
    public: true,
  });
  store.create({ ...defaultFields(null), title: "다음 여행 계획하기" });
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
