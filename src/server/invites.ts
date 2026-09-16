import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { hash, token, requireUser } from "./auth.js";
import type { Config } from "./config.js";
import { Store, HttpError, type User } from "./store.js";

const DAY = 86400000;
interface InviteRow {
  id: string;
  created_at: number;
  expires_at: number;
  used_at: number | null;
  used_by_email: string | null;
  revoked_at: number | null;
}
function metadata(row: InviteRow) {
  return {
    id: row.id,
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    usedAt: row.used_at ? new Date(row.used_at).toISOString() : null,
    usedByEmail: row.used_by_email,
    revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
  };
}
export function inviteRoutes(app: Express, store: Store, cfg: Config) {
  app.use("/api/invites", (req, res, next) => {
    if (req.headers.authorization)
      throw new HttpError(
        403,
        "초대 관리는 브라우저 세션으로만 가능합니다.",
      );
    res.locals.user = requireUser(req, store, cfg);
    next();
  });
  app.get("/api/invites", (_req, res) => {
    const user = res.locals.user as User;
    const rows = store.db
      .prepare(
        "SELECT i.*, u.email AS used_by_email FROM invites i LEFT JOIN users u ON u.id=i.used_by WHERE i.created_by=? ORDER BY i.created_at DESC",
      )
      .all(user.id) as unknown as InviteRow[];
    res.json({ invites: rows.map(metadata) });
  });
  app.post("/api/invites", (_req, res) => {
    const user = res.locals.user as User;
    const active = store.db
      .prepare(
        "SELECT count(*) AS n FROM invites WHERE created_by=? AND used_at IS NULL AND revoked_at IS NULL AND expires_at>?",
      )
      .get(user.id, Date.now())!;
    if (Number(active.n) >= 20)
      throw new HttpError(
        409,
        "대기 중인 초대는 최대 20개입니다. 사용하지 않는 초대를 취소해 주세요.",
      );
    const raw = token();
    const id = randomUUID(),
      now = Date.now(),
      expiresAt = now + 7 * DAY;
    store.db
      .prepare("INSERT INTO invites VALUES(?,?,?,?,?,?,?,?)")
      .run(id, hash(raw), user.id, now, expiresAt, null, null, null);
    res
      .status(201)
      .json({
        id,
        url: `${cfg.origin}/invite/${raw}`,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(expiresAt).toISOString(),
      });
  });
  app.post("/api/invites/:id/revoke", (req, res) => {
    const user = res.locals.user as User;
    const result = store.db
      .prepare(
        "UPDATE invites SET revoked_at=? WHERE id=? AND created_by=? AND used_at IS NULL AND revoked_at IS NULL",
      )
      .run(Date.now(), String(req.params.id), user.id);
    if (!result.changes) throw new HttpError(404, "초대를 찾을 수 없습니다.");
    res.json({ ok: true });
  });
}
