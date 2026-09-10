import webpush from "web-push";
import { addDays, today, reminderAt, startDate } from "../shared/domain.js";
import { hash } from "./auth.js";
import { Store, HttpError } from "./store.js";
import type { Config } from "./config.js";
export interface Subscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}
export function validateSubscription(s: Subscription) {
  if (!s || typeof s.endpoint !== "string" || s.endpoint.length > 2048)
    throw new HttpError(400, "알림 구독을 확인해 주세요.");
  const url = new URL(s.endpoint);
  const allowed =
    url.hostname === "fcm.googleapis.com" ||
    url.hostname === "updates.push.services.mozilla.com" ||
    url.hostname.endsWith(".notify.windows.com");
  if (
    url.protocol !== "https:" ||
    url.port ||
    url.username ||
    url.password ||
    !allowed ||
    !s.keys ||
    !/^[A-Za-z0-9_-]{87}$/.test(s.keys.p256dh) ||
    !/^[A-Za-z0-9_-]{22}$/.test(s.keys.auth)
  )
    throw new HttpError(400, "지원하지 않는 알림 구독입니다.");
  return {
    endpoint: s.endpoint,
    keys: { p256dh: s.keys.p256dh, auth: s.keys.auth },
  };
}
export function subscribe(store: Store, input: Subscription) {
  const s = validateSubscription(input),
    id = hash(s.endpoint);
  store.db
    .prepare(
      "INSERT INTO subscriptions VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
    )
    .run(id, JSON.stringify(s), Date.now());
  return id;
}
export function pushWorker(
  store: Store,
  cfg: Config,
  send = webpush.sendNotification,
) {
  let busy = false;
  const enabled = !!cfg.vapidPublic && !!cfg.vapidPrivate;
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      store.cleanup();
      if (!enabled) return;
      const now = Date.now();
      const occurrences = store.list(addDays(today(), -8), addDays(today(), 9));
      const subscriptions = store.db
        .prepare("SELECT * FROM subscriptions")
        .all();
      for (const o of occurrences) {
        const due = reminderAt(o);
        if (due === null || due > now || due < now - 15 * 60000) continue;
        for (const sub of subscriptions) {
          if (Number(sub.created_at) > due) continue;
          const id = hash(`${o.id}:${due}:${sub.id}`);
          store.db
            .prepare(
              "INSERT OR IGNORE INTO deliveries VALUES(?,?,'pending',0,0)",
            )
            .run(id, due);
          const job = store.db
            .prepare("SELECT * FROM deliveries WHERE id=?")
            .get(id)!;
          if (
            job.state === "sent" ||
            Number(job.attempts) >= 5 ||
            Number(job.retry_at) > now
          )
            continue;
          // Re-read just before sending: completed, moved, deleted or newly private states are current.
          const fresh = store
            .list(addDays(today(), -8), addDays(today(), 9))
            .find((x) => x.id === o.id);
          if (!fresh || reminderAt(fresh) !== due) continue;
          store.db
            .prepare(
              "UPDATE deliveries SET attempts=attempts+1,retry_at=? WHERE id=?",
            )
            .run(now + Math.min(300000, 30000 * 2 ** Number(job.attempts)), id);
          try {
            await send(
              JSON.parse(sub.data as string),
              JSON.stringify({
                title: fresh.title,
                body: "예정된 일정이 있습니다.",
                tag: id,
                url: `/?date=${startDate(fresh) || today()}`,
              }),
              {
                TTL: 900,
                timeout: 10000,
                vapidDetails: {
                  subject: cfg.vapidSubject,
                  publicKey: cfg.vapidPublic,
                  privateKey: cfg.vapidPrivate,
                },
                topic: id.slice(0, 32),
              },
            );
            store.db
              .prepare("UPDATE deliveries SET state='sent' WHERE id=?")
              .run(id);
          } catch (e) {
            const status = (e as { statusCode?: number }).statusCode;
            if (status === 404 || status === 410)
              store.db
                .prepare("DELETE FROM subscriptions WHERE id=?")
                .run(sub.id);
            console.warn("Push delivery failed", status || "network");
          }
        }
      }
    } finally {
      busy = false;
    }
  }
  const timer = setInterval(
    () =>
      void tick().catch(() => console.error("Notification scheduler failed")),
    30000,
  );
  timer.unref();
  return { tick, stop: () => clearInterval(timer) };
}
