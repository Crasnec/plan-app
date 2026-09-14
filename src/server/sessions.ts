import { randomUUID } from "node:crypto";
import type { Express, Response } from "express";
import { cookie, hash, requireOwner } from "./auth.js";
import type { Config } from "./config.js";
import { Store, HttpError } from "./store.js";
export function sessionRoutes(
  app: Express,
  store: Store,
  cfg: Config,
  revoked: (hash: string) => void,
  clear: (res: Response) => void,
) {
  app.use("/api/sessions", (req, _res, next) => {
    requireOwner(req, store, cfg);
    if (req.headers.authorization)
      throw new HttpError(403, "세션 관리는 소유자 브라우저에서만 가능합니다.");
    if (
      req.method !== "GET" &&
      (cfg.demo ||
        !req.body ||
        Array.isArray(req.body) ||
        Object.keys(req.body).length !== 0)
    )
      throw new HttpError(400, "세션 종료 요청을 확인해 주세요.");
    next();
  });
  app.get("/api/sessions", (req, res) => {
    if (cfg.demo) {
      res.json({ sessions: [], demo: true });
      return;
    }
    // Existing logins remain valid; unknown historical device/login time is never invented.
    for (const row of store.db
      .prepare(
        "SELECT hash FROM sessions WHERE expires>? AND hash NOT IN (SELECT session_hash FROM session_details)",
      )
      .all(Date.now())) {
      store.db
        .prepare(
          "INSERT OR IGNORE INTO session_details VALUES(?,?,?,NULL,NULL)",
        )
        .run(row.hash, randomUUID(), "알 수 없는 기기");
    }
    const current = hash(cookie(req, "plan_session"));
    const sessions = store.db
      .prepare(
        "SELECT d.*,s.expires FROM session_details d JOIN sessions s ON s.hash=d.session_hash WHERE s.expires>? ORDER BY (s.hash=?) DESC,d.last_seen DESC,s.expires DESC",
      )
      .all(Date.now(), current)
      .map((row) => ({
        id: row.id,
        device: row.device,
        current: row.session_hash === current,
        createdAt:
          row.created_at === null
            ? null
            : new Date(Number(row.created_at)).toISOString(),
        lastSeenAt:
          row.last_seen === null
            ? null
            : new Date(Number(row.last_seen)).toISOString(),
        expiresAt: new Date(Number(row.expires)).toISOString(),
      }));
    res.json({ sessions, demo: false });
  });
  app.post("/api/sessions/revoke-others", (req, res) => {
    const current = hash(cookie(req, "plan_session"));
    const removed = store.transaction(() => {
      const rows = store.db
        .prepare("SELECT hash FROM sessions WHERE hash<>? AND expires>?")
        .all(current, Date.now());
      store.db
        .prepare("DELETE FROM sessions WHERE hash<>? AND expires>?")
        .run(current, Date.now());
      return rows;
    });
    removed.forEach((row) => revoked(String(row.hash)));
    res.json({ current: false, count: removed.length });
  });
  app.post("/api/sessions/:id/revoke", (req, res) => {
    const row = store.db
      .prepare("SELECT session_hash FROM session_details WHERE id=?")
      .get(String(req.params.id));
    if (!row)
      throw new HttpError(404, "이미 종료되었거나 찾을 수 없는 세션입니다.");
    const sessionHash = String(row.session_hash);
    store.db.prepare("DELETE FROM sessions WHERE hash=?").run(sessionHash);
    revoked(sessionHash);
    const current = sessionHash === hash(cookie(req, "plan_session"));
    if (current) clear(res);
    res.json({ current });
  });
}
