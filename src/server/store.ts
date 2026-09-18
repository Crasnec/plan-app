import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  atDate,
  expand,
  validate,
  validKey,
  startDate,
  addDays,
  dateDiff,
  DAY,
  type Item,
  type Override,
  type Fields,
  type Scope,
} from "../shared/domain.js";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export interface User {
  id: string;
  email: string;
  googleSub: string;
  createdAt: number;
  shareHash: string | null;
  preferences: string | null;
  historyVersion: number;
}
interface UserRow {
  id: string;
  email: string;
  google_sub: string;
  created_at: number;
  share_hash: string | null;
  preferences: string | null;
  history_version: number;
}
const toUser = (row: UserRow): User => ({
  id: row.id,
  email: row.email,
  googleSub: row.google_sub,
  createdAt: row.created_at,
  shareHash: row.share_hash,
  preferences: row.preferences,
  historyVersion: row.history_version,
});
export class Store {
  db: DatabaseSync;
  private transactionActive = false;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS items(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS overrides(item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE, key TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(item_id,key));
      CREATE TABLE IF NOT EXISTS trash(id TEXT PRIMARY KEY, title TEXT NOT NULL, deleted_at INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS oauth(hash TEXT PRIMARY KEY, expires INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS subscriptions(id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY, due INTEGER NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL, retry_at INTEGER NOT NULL);
      INSERT OR IGNORE INTO migrations(version) VALUES(1);
      CREATE TABLE IF NOT EXISTS agent_keys(id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, scopes TEXT NOT NULL, owner_email TEXT NOT NULL, owner_sub TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER, last_used_at INTEGER);
      CREATE TABLE IF NOT EXISTS agent_requests(key_id TEXT NOT NULL REFERENCES agent_keys(id), request_key TEXT NOT NULL, fingerprint TEXT NOT NULL, status INTEGER NOT NULL, response TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(key_id,request_key));
      CREATE TABLE IF NOT EXISTS agent_audit(id TEXT PRIMARY KEY, key_id TEXT NOT NULL REFERENCES agent_keys(id), method TEXT NOT NULL, action TEXT NOT NULL, status INTEGER NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS agent_audit_time ON agent_audit(created_at);
      INSERT OR IGNORE INTO migrations(version) VALUES(2);
      CREATE TABLE IF NOT EXISTS mcp_oauth(id TEXT PRIMARY KEY, kind TEXT NOT NULL, expires INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS mcp_oauth_expiry ON mcp_oauth(expires);
      INSERT OR IGNORE INTO migrations(version) VALUES(3);
      CREATE TABLE IF NOT EXISTS session_details(session_hash TEXT PRIMARY KEY REFERENCES sessions(hash) ON DELETE CASCADE, id TEXT UNIQUE NOT NULL, device TEXT NOT NULL, created_at INTEGER, last_seen INTEGER);
      INSERT OR IGNORE INTO migrations(version) VALUES(4);
      CREATE TABLE IF NOT EXISTS mcp_connections(key_id TEXT PRIMARY KEY REFERENCES agent_keys(id));
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, email TEXT NOT NULL, google_sub TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, share_hash TEXT, preferences TEXT, history_version INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS invites(id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, created_by TEXT NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_by TEXT REFERENCES users(id), used_at INTEGER, revoked_at INTEGER);
      CREATE TABLE IF NOT EXISTS invite_uses(invite_id TEXT NOT NULL REFERENCES invites(id), user_id TEXT NOT NULL REFERENCES users(id), used_at INTEGER NOT NULL, PRIMARY KEY(invite_id,user_id));`);
    if (!this.db.prepare("SELECT 1 FROM migrations WHERE version=5").get())
      this.transaction(() => {
        const now = Date.now(),
          forever = 8640000000000000;
        this.db
          .prepare(
            `INSERT OR IGNORE INTO mcp_connections SELECT DISTINCT k.id FROM agent_keys k JOIN mcp_oauth o ON json_extract(o.data,'$.keyId')=k.id WHERE k.expires_at>? AND k.revoked_at IS NULL`,
          )
          .run(now);
        this.db
          .prepare(
            "UPDATE agent_keys SET expires_at=? WHERE id IN (SELECT key_id FROM mcp_connections)",
          )
          .run(forever);
        this.db
          .prepare(
            "UPDATE mcp_oauth SET expires=? WHERE kind IN ('refresh','used_refresh') AND expires>? AND json_extract(data,'$.keyId') IN (SELECT key_id FROM mcp_connections)",
          )
          .run(forever, now);
        this.db.exec("INSERT INTO migrations VALUES(5)");
      });
    // Multi-tenant: every calendar/session/key row now belongs to a user. Columns
    // are added nullable (SQLite can't add a NOT NULL column to an existing table
    // without a default); ownership is enforced in application code instead, and
    // index.ts backfills a first user from the pre-migration single-owner data.
    if (!this.db.prepare("SELECT 1 FROM migrations WHERE version=6").get())
      this.transaction(() => {
        this.db.exec(`ALTER TABLE items ADD COLUMN user_id TEXT;
          ALTER TABLE overrides ADD COLUMN user_id TEXT;
          ALTER TABLE trash ADD COLUMN user_id TEXT;
          ALTER TABLE sessions ADD COLUMN user_id TEXT;
          ALTER TABLE agent_keys ADD COLUMN user_id TEXT;
          ALTER TABLE subscriptions ADD COLUMN user_id TEXT;
          CREATE INDEX IF NOT EXISTS items_user ON items(user_id);
          CREATE INDEX IF NOT EXISTS overrides_user ON overrides(user_id);
          CREATE INDEX IF NOT EXISTS trash_user ON trash(user_id);
          CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
          CREATE INDEX IF NOT EXISTS agent_keys_user ON agent_keys(user_id);
          CREATE INDEX IF NOT EXISTS subscriptions_user ON subscriptions(user_id);`);
        this.db.exec("INSERT INTO migrations VALUES(6)");
      });
    // Rebuild the identity index so a deleted Google identity can register anew.
    if (!this.db.prepare("SELECT 1 FROM migrations WHERE version=7").get()) {
      this.db.exec("PRAGMA foreign_keys=OFF");
      try {
        this.transaction(() => {
          this.db.exec(`CREATE TABLE users_next(id TEXT PRIMARY KEY, email TEXT NOT NULL, google_sub TEXT NOT NULL, created_at INTEGER NOT NULL, share_hash TEXT, preferences TEXT, history_version INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER);
            INSERT INTO users_next SELECT *,NULL FROM users;
            DROP TABLE users;
            ALTER TABLE users_next RENAME TO users;
            CREATE UNIQUE INDEX users_active_sub ON users(google_sub) WHERE deleted_at IS NULL;
            ALTER TABLE deliveries ADD COLUMN user_id TEXT;
            INSERT INTO migrations VALUES(7);`);
          if (this.db.prepare("PRAGMA foreign_key_check").get())
            throw new Error("Account migration failed foreign key validation");
        });
      } finally {
        this.db.exec("PRAGMA foreign_keys=ON");
      }
    }
  }
  transaction<T>(fn: () => T): T {
    if (this.transactionActive) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.transactionActive = true;
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    } finally {
      this.transactionActive = false;
    }
  }
  setting(key: string): string | null {
    return (
      (
        this.db.prepare("SELECT value FROM settings WHERE key=?").get(key) as
          { value: string } | undefined
      )?.value ?? null
    );
  }
  set(key: string, value: string) {
    this.db
      .prepare(
        "INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, value);
  }
  user(id: string): User | undefined {
    const row = this.db.prepare("SELECT * FROM users WHERE deleted_at IS NULL AND id=?").get(id) as
      | UserRow
      | undefined;
    return row && toUser(row);
  }
  userBySub(googleSub: string): User | undefined {
    const row = this.db
      .prepare("SELECT * FROM users WHERE deleted_at IS NULL AND google_sub=?")
      .get(googleSub) as UserRow | undefined;
    return row && toUser(row);
  }
  userByShareHash(shareHash: string): User | undefined {
    const row = this.db
      .prepare("SELECT * FROM users WHERE deleted_at IS NULL AND share_hash=?")
      .get(shareHash) as UserRow | undefined;
    return row && toUser(row);
  }
  createUser(email: string, googleSub: string): User {
    const row: UserRow = {
      id: randomUUID(),
      email,
      google_sub: googleSub,
      created_at: Date.now(),
      share_hash: null,
      preferences: null,
      history_version: 0,
    };
    this.db
      .prepare("INSERT INTO users(id,email,google_sub,created_at,share_hash,preferences,history_version) VALUES(?,?,?,?,?,?,?)")
      .run(
        row.id,
        row.email,
        row.google_sub,
        row.created_at,
        row.share_hash,
        row.preferences,
        row.history_version,
      );
    return toUser(row);
  }
  isUserDeleted(id: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM users WHERE id=? AND deleted_at IS NOT NULL").get(id);
  }
  // Owned rows inherit this tombstone, including settings, trash, credentials,
  // invitation usage and audit records. Keep their original contents for retention.
  withdrawUser(id: string): string[] {
    return this.transaction(() => {
      if (!this.user(id)) throw new HttpError(401, "로그인이 필요합니다.");
      const sessions = this.db.prepare("SELECT hash FROM sessions WHERE user_id=?").all(id);
      const now = Date.now();
      this.db.prepare("UPDATE users SET deleted_at=? WHERE id=?").run(now, id);
      this.db.prepare("UPDATE agent_keys SET revoked_at=coalesce(revoked_at,?) WHERE user_id=?").run(now, id);
      this.db.prepare("UPDATE invites SET revoked_at=coalesce(revoked_at,?) WHERE created_by=?").run(now, id);
      return sessions.map((row) => String(row.hash));
    });
  }
  setUserShareHash(id: string, shareHash: string | null) {
    this.db
      .prepare("UPDATE users SET share_hash=? WHERE id=?")
      .run(shareHash, id);
  }
  setUserPreferences(id: string, preferences: string) {
    this.db
      .prepare("UPDATE users SET preferences=? WHERE id=?")
      .run(preferences, id);
  }
  setUserHistoryVersion(id: string, version: number) {
    this.db
      .prepare("UPDATE users SET history_version=? WHERE id=?")
      .run(version, id);
  }
  items(userId: string): Item[] {
    if (this.isUserDeleted(userId)) return [];
    return this.db
      .prepare("SELECT data FROM items WHERE user_id=?")
      .all(userId)
      .map((r) => JSON.parse(r.data as string));
  }
  overrides(userId: string): Override[] {
    if (this.isUserDeleted(userId)) return [];
    return this.db
      .prepare("SELECT data FROM overrides WHERE user_id=?")
      .all(userId)
      .map((r) => JSON.parse(r.data as string));
  }
  item(id: string, userId: string): Item {
    if (this.isUserDeleted(userId)) throw new HttpError(404, "일정을 찾을 수 없습니다.");
    const row = this.db
      .prepare("SELECT data FROM items WHERE id=? AND user_id=?")
      .get(id, userId);
    if (!row) throw new HttpError(404, "일정을 찾을 수 없습니다.");
    return JSON.parse(row.data as string);
  }
  save(item: Item, userId: string) {
    if (this.isUserDeleted(userId)) throw new HttpError(401, "탈퇴한 계정입니다.");
    this.db
      .prepare(
        "INSERT INTO items VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(item.id, JSON.stringify(item), userId);
  }
  saveOverride(o: Override, userId: string) {
    if (this.isUserDeleted(userId)) throw new HttpError(401, "탈퇴한 계정입니다.");
    this.db
      .prepare(
        "INSERT INTO overrides VALUES(?,?,?,?) ON CONFLICT(item_id,key) DO UPDATE SET data=excluded.data",
      )
      .run(o.itemId, o.key, JSON.stringify(o), userId);
  }
  list(userId: string, from: string, to: string, publicOnly = false) {
    return expand(
      this.items(userId),
      this.overrides(userId),
      from,
      to,
      publicOnly,
    );
  }
  create(userId: string, input: unknown) {
    const fields = validate(input);
    if (fields.rule && fields.done)
      throw new HttpError(
        400,
        "반복 일정은 저장 후 각 회차에서 완료 표시해 주세요.",
      );
    const item: Item = {
      ...fields,
      id: randomUUID(),
      version: 1,
      deletedAt: null,
      cutoff: null,
    };
    this.save(item, userId);
    return item;
  }
  mutate(
    userId: string,
    id: string,
    key: string,
    version: number,
    scope: Scope,
    input: unknown,
    deleting = false,
  ) {
    return this.transaction(() => {
      const item = this.item(id, userId);
      if (item.deletedAt) throw new HttpError(404, "삭제된 일정입니다.");
      if (item.version !== version)
        throw new HttpError(
          409,
          "다른 기기에서 변경된 일정입니다. 창을 닫고 최신 내용을 다시 열어 주세요.",
        );
      if (!["one", "future", "all"].includes(scope) || !validKey(item, key))
        throw new HttpError(400, "변경 범위 또는 회차가 올바르지 않습니다.");
      const exceptions = this.overrides(userId).filter((o) => o.itemId === id);
      const existing = exceptions.find((o) => o.key === key);
      if (existing?.deletedAt) throw new HttpError(404, "삭제된 회차입니다.");
      const current = { ...atDate(item, key), ...existing?.patch };
      const before = { item, exceptions };
      const next = { ...item, version: item.version + 1 };
      const fields = deleting ? null : validate(input);
      if (
        fields &&
        item.rule &&
        scope !== "one" &&
        fields.done !== current.done
      )
        throw new HttpError(
          400,
          "완료 상태는 ‘이번만’ 범위에서 변경해 주세요.",
        );
      if (fields && !item.rule && fields.rule && fields.done)
        throw new HttpError(
          400,
          "반복 일정으로 바꾸기 전에 완료 표시를 해제해 주세요.",
        );
      if (!item.rule || scope === "all") {
        if (deleting) next.deletedAt = new Date().toISOString();
        else {
          Object.assign(next, fields);
          if (item.rule && next.rule) next.done = item.done;
          if (
            item.rule &&
            fields!.kind === item.kind &&
            fields!.kind !== "undated"
          ) {
            const delta =
              item.kind === "timed"
                ? Date.parse(fields!.start!) - Date.parse(current.start!)
                : dateDiff(fields!.start!, current.start!) * DAY;
            const duration =
              item.kind === "timed"
                ? Date.parse(fields!.end!) - Date.parse(fields!.start!)
                : dateDiff(fields!.end!, fields!.start!) * DAY;
            next.start =
              item.kind === "timed"
                ? new Date(Date.parse(item.start!) + delta).toISOString()
                : addDays(item.start!, delta / DAY);
            next.end =
              item.kind === "timed"
                ? new Date(Date.parse(next.start!) + duration).toISOString()
                : addDays(next.start!, duration / DAY);
          }
          validate(next);
          if (
            item.rule &&
            fields!.kind !== item.kind &&
            fields!.kind !== "undated" &&
            item.kind !== "undated"
          ) {
            // Changing type from a later occurrence must not move the series anchor to that occurrence.
            const anchor = addDays(
              startDate(item)!,
              dateDiff(startDate(fields!)!, startDate(current)!),
            );
            const shifted = atDate(next, anchor);
            next.start = shifted.start;
            next.end = shifted.end;
            validate(next);
          }
        }
        this.save(next, userId);
        if (!deleting) this.preserveExceptions(userId, item, next, exceptions);
      } else if (scope === "one") {
        const patch: Partial<Fields> = { ...existing?.patch };
        if (fields) {
          for (const name of [
            "title",
            "notes",
            "kind",
            "start",
            "end",
            "public",
            "done",
            "reminder",
          ] as const) {
            if (JSON.stringify(fields[name]) !== JSON.stringify(current[name]))
              (patch as Record<string, unknown>)[name] = fields[name];
          }
          if (fields.kind === "undated")
            throw new HttpError(400, "반복 회차에는 날짜가 필요합니다.");
        }
        this.saveOverride(
          {
            itemId: id,
            key,
            patch,
            deletedAt: deleting ? new Date().toISOString() : null,
          },
          userId,
        );
        this.save(next, userId);
      } else {
        next.cutoff = key;
        this.save(next, userId);
        if (fields) {
          const successor: Item = {
            ...fields,
            done: fields.rule ? false : fields.done,
            id: randomUUID(),
            version: 1,
            deletedAt: null,
            cutoff: item.cutoff,
          };
          this.save(successor, userId);
          // Keep exceptions anchored to their original Korean calendar date. Non-matching dates stay dormant.
          for (const o of exceptions.filter((o) => o.key >= key)) {
            this.saveOverride({ ...o, itemId: successor.id }, userId);
            this.db
              .prepare("DELETE FROM overrides WHERE item_id=? AND key=?")
              .run(id, o.key);
          }
          this.preserveExceptions(
            userId,
            item,
            successor,
            exceptions
              .filter((o) => o.key >= key)
              .map((o) => ({ ...o, itemId: successor.id })),
          );
        }
      }
      if (deleting)
        this.db.prepare("INSERT INTO trash VALUES(?,?,?,?,?)").run(
          randomUUID(),
          item.title,
          Date.now(),
          JSON.stringify({
            before,
            after: next,
            scope: item.rule ? scope : "all",
            key,
            deletedOverride: this.overrides(userId).find(
              (o) => o.itemId === id && o.key === key,
            ),
          }),
          userId,
        );
      return next;
    });
  }
  preserveExceptions(
    userId: string,
    old: Item,
    next: Item,
    exceptions: Override[],
  ) {
    for (const o of exceptions) {
      const concrete = { ...atDate(old, o.key), ...o.patch };
      if (!validKey(next, o.key)) {
        if (!o.deletedAt) this.create(userId, { ...concrete, rule: null });
        this.db
          .prepare("DELETE FROM overrides WHERE item_id=? AND key=?")
          .run(next.id, o.key);
      } else if (concrete.done || o.patch.start !== undefined) {
        // Completed or explicitly moved occurrences retain their original actual dates.
        this.saveOverride(
          {
            ...o,
            patch: {
              ...o.patch,
              kind: concrete.kind,
              start: concrete.start,
              end: concrete.end,
            },
          },
          userId,
        );
      }
    }
  }
  trash(userId: string) {
    if (this.isUserDeleted(userId)) return [];
    this.cleanup();
    return this.db
      .prepare(
        "SELECT id,title,deleted_at FROM trash WHERE user_id=? ORDER BY deleted_at DESC",
      )
      .all(userId);
  }
  restore(userId: string, id: string) {
    if (this.isUserDeleted(userId)) throw new HttpError(404, "복구할 수 없는 계정입니다.");
    return this.transaction(() => {
      const row = this.db
        .prepare("SELECT * FROM trash WHERE id=? AND user_id=?")
        .get(id, userId);
      if (!row || Number(row.deleted_at) < Date.now() - 30 * DAY)
        throw new HttpError(404, "복구 기간이 지난 항목입니다.");
      const { before, after, scope, key, deletedOverride } = JSON.parse(
        row.data as string,
      ) as {
        before: { item: Item; exceptions: Override[] };
        after: Item;
        scope: Scope;
        key: string;
        deletedOverride: Override;
      };
      const current = this.item(before.item.id, userId);
      if (scope === "one") {
        const currentOverride = this.overrides(userId).find(
          (o) => o.itemId === current.id && o.key === key,
        );
        if (
          current.deletedAt ||
          !validKey(current, key) ||
          JSON.stringify(currentOverride) !== JSON.stringify(deletedOverride)
        )
          throw new HttpError(
            409,
            "먼저 이 회차가 속한 반복 일정을 복구해 주세요.",
          );
        const old = before.exceptions.find((o) => o.key === key);
        if (old) this.saveOverride(old, userId);
        else
          this.db
            .prepare("DELETE FROM overrides WHERE item_id=? AND key=?")
            .run(current.id, key);
        this.save({ ...current, version: current.version + 1 }, userId);
        this.db.prepare("DELETE FROM trash WHERE id=?").run(id);
        return;
      }
      if (scope === "future") {
        if (current.deletedAt || current.cutoff !== after.cutoff)
          throw new HttpError(
            409,
            "최근에 삭제한 이후 일정을 먼저 복구해 주세요.",
          );
        this.save(
          {
            ...current,
            cutoff: before.item.cutoff,
            version: current.version + 1,
          },
          userId,
        );
        this.db.prepare("DELETE FROM trash WHERE id=?").run(id);
        return;
      }
      if (current.deletedAt !== after.deletedAt || !current.deletedAt)
        throw new HttpError(409, "이미 복구되었거나 변경된 일정입니다.");
      this.save({ ...before.item, version: current.version + 1 }, userId);
      this.db.prepare("DELETE FROM overrides WHERE item_id=?").run(current.id);
      for (const o of before.exceptions) this.saveOverride(o, userId);
      this.db.prepare("DELETE FROM trash WHERE id=?").run(id);
      // Older trash snapshots refer to the restored content with its prior version.
      for (const old of this.db
        .prepare("SELECT id,data FROM trash WHERE user_id=?")
        .all(userId)) {
        const data = JSON.parse(old.data as string);
        if (
          data.after.id === current.id &&
          JSON.stringify({ ...data.after, version: 0 }) ===
            JSON.stringify({ ...before.item, version: 0 })
        ) {
          data.after.version = current.version + 1;
          this.db
            .prepare("UPDATE trash SET data=? WHERE id=?")
            .run(JSON.stringify(data), old.id);
        }
      }
    });
  }
  cleanup() {
    const now = Date.now();
    this.db
      .prepare("DELETE FROM agent_requests WHERE key_id NOT IN (SELECT k.id FROM agent_keys k JOIN users u ON u.id=k.user_id WHERE u.deleted_at IS NOT NULL) AND created_at<?")
      .run(now - 7 * DAY);
    this.db
      .prepare("DELETE FROM agent_audit WHERE key_id NOT IN (SELECT k.id FROM agent_keys k JOIN users u ON u.id=k.user_id WHERE u.deleted_at IS NOT NULL) AND created_at<?")
      .run(now - 30 * DAY);
    this.db.exec(
      "DELETE FROM agent_audit WHERE id IN (SELECT id FROM agent_audit WHERE key_id NOT IN (SELECT k.id FROM agent_keys k JOIN users u ON u.id=k.user_id WHERE u.deleted_at IS NOT NULL) ORDER BY created_at DESC LIMIT -1 OFFSET 10000)",
    );
    this.db.prepare("DELETE FROM trash WHERE user_id NOT IN (SELECT id FROM users WHERE deleted_at IS NOT NULL) AND deleted_at<?").run(now - 30 * DAY);
    for (const row of this.db.prepare("SELECT id,data FROM items WHERE user_id NOT IN (SELECT id FROM users WHERE deleted_at IS NOT NULL)").all() as {
      id: string;
      data: string;
    }[]) {
      const item = JSON.parse(row.data) as Item;
      if (item.deletedAt && Date.parse(item.deletedAt) < now - 30 * DAY)
        this.db.prepare("DELETE FROM items WHERE id=?").run(item.id);
    }
    this.db.prepare("DELETE FROM sessions WHERE user_id NOT IN (SELECT id FROM users WHERE deleted_at IS NOT NULL) AND expires<?").run(now);
    this.db.prepare("DELETE FROM oauth WHERE expires<?").run(now);
    this.db.prepare("DELETE FROM mcp_oauth WHERE coalesce(json_extract(data,'$.keyId'),'') NOT IN (SELECT k.id FROM agent_keys k JOIN users u ON u.id=k.user_id WHERE u.deleted_at IS NOT NULL) AND coalesce(json_extract(data,'$.session'),'') NOT IN (SELECT s.hash FROM sessions s JOIN users u ON u.id=s.user_id WHERE u.deleted_at IS NOT NULL) AND expires<=?").run(now);
    this.db.prepare("DELETE FROM deliveries WHERE user_id IN (SELECT id FROM users WHERE deleted_at IS NULL) AND due<?").run(now - 30 * DAY);
    this.db
      .prepare(
        "DELETE FROM invites WHERE id NOT IN (SELECT invite_id FROM invite_uses) AND created_by NOT IN (SELECT id FROM users WHERE deleted_at IS NOT NULL) AND used_at IS NULL AND revoked_at IS NULL AND expires_at<?",
      )
      .run(now - 30 * DAY);
  }
}
