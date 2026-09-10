import { randomUUID } from "node:crypto";
import { Store, HttpError } from "./store.js";
type Row = Record<string, string | number | null>;
type Snapshot = { items: Row[]; overrides: Row[]; trash: Row[] };
type Entry = { id: string; label: string; before: Snapshot; after: Snapshot };
type Stack = { undo: Entry[]; redo: Entry[]; touched: number };
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
};
export class History {
  private sessions = new Map<string, Stack>();
  constructor(private store: Store) {}
  private snapshot(): Snapshot {
    return {
      items: this.store.db
        .prepare("SELECT * FROM items ORDER BY id")
        .all() as Row[],
      overrides: this.store.db
        .prepare("SELECT * FROM overrides ORDER BY item_id,key")
        .all() as Row[],
      trash: this.store.db
        .prepare("SELECT * FROM trash ORDER BY id")
        .all() as Row[],
    };
  }
  private signature(snapshot: Snapshot) {
    return canonical({
      ...snapshot,
      items: snapshot.items.map((row) => ({
        ...row,
        data: { ...JSON.parse(String(row.data)), version: 0 },
      })),
    });
  }
  private prune() {
    for (const [key, stack] of this.sessions)
      if (stack.touched < Date.now() - 30 * 60000) this.sessions.delete(key);
    let size = 0;
    for (const [key, stack] of [...this.sessions].reverse()) {
      size += Buffer.byteLength(JSON.stringify(stack));
      if (size > 16 * 1024 * 1024) this.sessions.delete(key);
    }
  }
  record<T>(session: string, label: string, fn: () => T): T {
    this.prune();
    const { value, before, after } = this.store.transaction(() => {
      const before = this.snapshot();
      const value = fn();
      return { value, before, after: this.snapshot() };
    });
    if (this.signature(before) === this.signature(after)) return value;
    const stack = this.sessions.get(session) || {
      undo: [],
      redo: [],
      touched: Date.now(),
    };
    const last = stack.undo.at(-1);
    if (last && this.signature(last.after) !== this.signature(before))
      stack.undo = [];
    stack.redo = [];
    if (Buffer.byteLength(JSON.stringify({ before, after })) > 1024 * 1024) {
      this.sessions.delete(session);
      return value;
    }
    stack.undo.push({ id: randomUUID(), label, before, after });
    stack.undo = stack.undo.slice(-20);
    stack.touched = Date.now();
    this.sessions.delete(session);
    this.sessions.set(session, stack);
    this.prune();
    return value;
  }
  state(session: string) {
    this.prune();
    const stack = this.sessions.get(session);
    const summary = (entry?: Entry) =>
      entry ? { id: entry.id, label: entry.label } : null;
    return {
      undo: summary(stack?.undo.at(-1)),
      redo: summary(stack?.redo.at(-1)),
    };
  }
  apply(session: string, direction: "undo" | "redo", id: unknown) {
    this.prune();
    const stack = this.sessions.get(session),
      entry = stack?.[direction].at(-1);
    if (!stack || !entry || typeof id !== "string" || entry.id !== id)
      throw new HttpError(
        409,
        "되돌리기 기록이 바뀌었거나 만료되었습니다. 다시 확인해 주세요.",
      );
    const expected = direction === "undo" ? entry.after : entry.before;
    const target = direction === "undo" ? entry.before : entry.after;
    this.store.transaction(() => {
      const current = this.snapshot();
      if (this.signature(current) !== this.signature(expected))
        throw new HttpError(
          409,
          "다른 작업으로 일정이 변경되어 되돌릴 수 없습니다. 최신 일정을 확인해 주세요.",
        );
      // Never reuse item versions: stale browser/agent writes must stay stale after undo/redo.
      const version =
        Math.max(
          Number(this.store.setting("history_version") || 0),
          ...current.items.map((r) => JSON.parse(String(r.data)).version),
          ...target.items.map((r) => JSON.parse(String(r.data)).version),
        ) + 1;
      this.store.set("history_version", String(version));
      this.store.db.exec(
        "DELETE FROM overrides; DELETE FROM items; DELETE FROM trash;",
      );
      for (const row of target.items)
        this.store.db
          .prepare("INSERT INTO items VALUES(?,?)")
          .run(
            row.id,
            JSON.stringify({ ...JSON.parse(String(row.data)), version }),
          );
      for (const row of target.overrides)
        this.store.db
          .prepare("INSERT INTO overrides VALUES(?,?,?)")
          .run(row.item_id, row.key, row.data);
      for (const row of target.trash)
        this.store.db
          .prepare("INSERT INTO trash VALUES(?,?,?,?)")
          .run(row.id, row.title, row.deleted_at, row.data);
    });
    stack[direction].pop();
    entry.id = randomUUID();
    stack[direction === "undo" ? "redo" : "undo"].push(entry);
    stack.touched = Date.now();
    return this.state(session);
  }
}
