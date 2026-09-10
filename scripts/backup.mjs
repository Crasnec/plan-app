import { DatabaseSync, backup } from "node:sqlite";
import { mkdir, lstat, open } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
process.umask(0o077);
const source = process.env.DATABASE_PATH || "data/plan.sqlite";
const directory = process.env.BACKUP_DIR || "backups";
await mkdir(directory, { recursive: true, mode: 0o700 });
const directoryInfo = await lstat(directory);
if (!directoryInfo.isDirectory() || (directoryInfo.mode & 0o077) !== 0)
  throw new Error(
    "BACKUP_DIR must be a private directory (0700), not a symlink. Check existing backup permissions before retrying.",
  );
const target = resolve(
  directory,
  `plan-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}.sqlite`,
);
const reserved = await open(target, "wx", 0o600);
await reserved.close();
const db = new DatabaseSync(source, { readOnly: true });
try {
  await backup(db, target);
} finally {
  db.close();
}
const copy = new DatabaseSync(target, { readOnly: true });
const check = copy.prepare("PRAGMA integrity_check").get();
copy.close();
if (check.integrity_check !== "ok")
  throw new Error("Backup integrity check failed");
console.log(`Verified backup: ${target}`);
