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
      INSERT OR IGNORE INTO migrations(version) VALUES(2);`);
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
  items(): Item[] {
    return this.db
      .prepare("SELECT data FROM items")
      .all()
      .map((r) => JSON.parse(r.data as string));
  }
  overrides(): Override[] {
    return this.db
      .prepare("SELECT data FROM overrides")
      .all()
      .map((r) => JSON.parse(r.data as string));
  }
  item(id: string): Item {
    const row = this.db.prepare("SELECT data FROM items WHERE id=?").get(id);
    if (!row) throw new HttpError(404, "일정을 찾을 수 없습니다.");
    return JSON.parse(row.data as string);
  }
  save(item: Item) {
    this.db
      .prepare(
        "INSERT INTO items VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(item.id, JSON.stringify(item));
  }
  saveOverride(o: Override) {
    this.db
      .prepare(
        "INSERT INTO overrides VALUES(?,?,?) ON CONFLICT(item_id,key) DO UPDATE SET data=excluded.data",
      )
      .run(o.itemId, o.key, JSON.stringify(o));
  }
  list(from: string, to: string, publicOnly = false) {
    return expand(this.items(), this.overrides(), from, to, publicOnly);
  }
  create(input: unknown) {
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
    this.save(item);
    return item;
  }
  mutate(
    id: string,
    key: string,
    version: number,
    scope: Scope,
    input: unknown,
    deleting = false,
  ) {
    return this.transaction(() => {
      const item = this.item(id);
      if (item.deletedAt) throw new HttpError(404, "삭제된 일정입니다.");
      if (item.version !== version)
        throw new HttpError(
          409,
          "다른 기기에서 변경된 일정입니다. 창을 닫고 최신 내용을 다시 열어 주세요.",
        );
      if (!["one", "future", "all"].includes(scope) || !validKey(item, key))
        throw new HttpError(400, "변경 범위 또는 회차가 올바르지 않습니다.");
      const exceptions = this.overrides().filter((o) => o.itemId === id);
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
        }
        this.save(next);
        if (!deleting) this.preserveExceptions(item, next, exceptions);
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
        this.saveOverride({
          itemId: id,
          key,
          patch,
          deletedAt: deleting ? new Date().toISOString() : null,
        });
        this.save(next);
      } else {
        next.cutoff = key;
        this.save(next);
        if (fields) {
          const successor: Item = {
            ...fields,
            done: fields.rule ? false : fields.done,
            id: randomUUID(),
            version: 1,
            deletedAt: null,
            cutoff: item.cutoff,
          };
          this.save(successor);
          // Keep exceptions anchored to their original Korean calendar date. Non-matching dates stay dormant.
          for (const o of exceptions.filter((o) => o.key >= key)) {
            this.saveOverride({ ...o, itemId: successor.id });
            this.db
              .prepare("DELETE FROM overrides WHERE item_id=? AND key=?")
              .run(id, o.key);
          }
          this.preserveExceptions(
            item,
            successor,
            exceptions
              .filter((o) => o.key >= key)
              .map((o) => ({ ...o, itemId: successor.id })),
          );
        }
      }
      if (deleting)
        this.db.prepare("INSERT INTO trash VALUES(?,?,?,?)").run(
          randomUUID(),
          item.title,
          Date.now(),
          JSON.stringify({
            before,
            after: next,
            scope: item.rule ? scope : "all",
            key,
            deletedOverride: this.overrides().find(
              (o) => o.itemId === id && o.key === key,
            ),
          }),
        );
      return next;
    });
  }
  preserveExceptions(old: Item, next: Item, exceptions: Override[]) {
    for (const o of exceptions) {
      const concrete = { ...atDate(old, o.key), ...o.patch };
      if (!validKey(next, o.key)) {
        if (!o.deletedAt) this.create({ ...concrete, rule: null });
        this.db
          .prepare("DELETE FROM overrides WHERE item_id=? AND key=?")
          .run(next.id, o.key);
      } else if (concrete.done || o.patch.start !== undefined) {
        // Completed or explicitly moved occurrences retain their original actual dates.
        this.saveOverride({
          ...o,
          patch: {
            ...o.patch,
            kind: concrete.kind,
            start: concrete.start,
            end: concrete.end,
          },
        });
      }
    }
  }
  trash() {
    this.cleanup();
    return this.db
      .prepare("SELECT id,title,deleted_at FROM trash ORDER BY deleted_at DESC")
      .all();
  }
  restore(id: string) {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM trash WHERE id=?").get(id);
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
      const current = this.item(before.item.id);
      if (scope === "one") {
        const currentOverride = this.overrides().find(
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
        if (old) this.saveOverride(old);
        else
          this.db
            .prepare("DELETE FROM overrides WHERE item_id=? AND key=?")
            .run(current.id, key);
        this.save({ ...current, version: current.version + 1 });
        this.db.prepare("DELETE FROM trash WHERE id=?").run(id);
        return;
      }
      if (scope === "future") {
        if (current.deletedAt || current.cutoff !== after.cutoff)
          throw new HttpError(
            409,
            "최근에 삭제한 이후 일정을 먼저 복구해 주세요.",
          );
        this.save({
          ...current,
          cutoff: before.item.cutoff,
          version: current.version + 1,
        });
        this.db.prepare("DELETE FROM trash WHERE id=?").run(id);
        return;
      }
      if (current.deletedAt !== after.deletedAt || !current.deletedAt)
        throw new HttpError(409, "이미 복구되었거나 변경된 일정입니다.");
      this.save({ ...before.item, version: current.version + 1 });
      this.db.prepare("DELETE FROM overrides WHERE item_id=?").run(current.id);
      for (const o of before.exceptions) this.saveOverride(o);
      this.db.prepare("DELETE FROM trash WHERE id=?").run(id);
      // Older trash snapshots refer to the restored content with its prior version.
      for (const old of this.db.prepare("SELECT id,data FROM trash").all()) {
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
      .prepare("DELETE FROM agent_requests WHERE created_at<?")
      .run(now - 7 * DAY);
    this.db
      .prepare("DELETE FROM agent_audit WHERE created_at<?")
      .run(now - 30 * DAY);
    this.db.exec(
      "DELETE FROM agent_audit WHERE id IN (SELECT id FROM agent_audit ORDER BY created_at DESC LIMIT -1 OFFSET 10000)",
    );
    this.db.prepare("DELETE FROM trash WHERE deleted_at<?").run(now - 30 * DAY);
    for (const item of this.items())
      if (item.deletedAt && Date.parse(item.deletedAt) < now - 30 * DAY)
        this.db.prepare("DELETE FROM items WHERE id=?").run(item.id);
    this.db.prepare("DELETE FROM sessions WHERE expires<?").run(now);
    this.db.prepare("DELETE FROM oauth WHERE expires<?").run(now);
    this.db.prepare("DELETE FROM deliveries WHERE due<?").run(now - 30 * DAY);
  }
}
