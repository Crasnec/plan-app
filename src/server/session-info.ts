import { randomUUID } from "node:crypto";
import type { Request } from "express";
import type { Store } from "./store.js";
export function deviceName(userAgent: string): string {
  const ua = userAgent.slice(0, 1024);
  const os = /Android/i.test(ua)
    ? "Android"
    : /iPhone/i.test(ua)
      ? "iPhone"
      : /iPad/i.test(ua)
        ? "iPad"
        : /Windows/i.test(ua)
          ? "Windows"
          : /Macintosh|Mac OS X/i.test(ua)
            ? "Mac"
            : /Linux/i.test(ua)
              ? "Linux"
              : "기기";
  const browser = /SamsungBrowser\//i.test(ua)
    ? "Samsung Internet"
    : /Edg(?:e|A|iOS)?\//i.test(ua)
      ? "Edge"
      : /OPR\//i.test(ua)
        ? "Opera"
        : /Firefox\/|FxiOS\//i.test(ua)
          ? "Firefox"
          : /Chrome\/|CriOS\//i.test(ua)
            ? "Chrome"
            : /Safari\//i.test(ua)
              ? "Safari"
              : "브라우저";
  return !ua ? "알 수 없는 기기" : `${os} · ${browser}`;
}
export function touchSession(
  store: Store,
  req: Request,
  sessionHash: string,
  createdAt: number | null = null,
) {
  const now = Date.now();
  store.db
    .prepare(
      `INSERT INTO session_details VALUES(?,?,?,?,?)
    ON CONFLICT(session_hash) DO UPDATE SET last_seen=excluded.last_seen, device=excluded.device
    WHERE session_details.last_seen IS NULL OR session_details.last_seen<?`,
    )
    .run(
      sessionHash,
      randomUUID(),
      deviceName(req.headers["user-agent"] || ""),
      createdAt,
      now,
      now - 60000,
    );
}
