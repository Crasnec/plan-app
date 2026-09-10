import express from "express";
import type { Response } from "express";
import { resolve } from "node:path";
import { Store, HttpError } from "./store.js";
import {
  authRoutes,
  owner,
  requireOwner,
  token,
  hash,
  cookie,
} from "./auth.js";
import { subscribe } from "./push.js";
import { agentRouter, agentManagement } from "./agents.js";
import type { Config } from "./config.js";
import { validDate, dateDiff, type Scope } from "../shared/domain.js";
import { errorPage } from "./error-page.js";

export function createApp(
  store: Store,
  cfg: Config,
  staticDir = resolve("dist/public"),
) {
  const app = express();
  app.disable("x-powered-by");
  const clients = new Map<
    Response,
    { sessionHash: string; authorized: () => boolean; close: () => void }
  >();
  const broadcast = () => {
    for (const [res, client] of clients) {
      if (!client.authorized()) client.close();
      else res.write("event: change\ndata: {}\n\n");
    }
  };
  app.use((_req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "X-Robots-Tag": "noindex, nofollow",
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    next();
  });
  app.use(express.json({ limit: "32kb" }));
  app.use("/api/agent/v1", agentRouter(store, cfg, broadcast));
  app.use((req, _res, next) => {
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      (req.headers.origin !== cfg.origin || !req.is("application/json"))
    )
      return next(new HttpError(403, "허용되지 않은 요청입니다."));
    next();
  });
  app.get("/healthz", (_req, res) => {
    store.db.prepare("SELECT 1").get();
    res.json({ ok: true });
  });
  app.get("/api/me", (req, res) =>
    res.json({
      owner: owner(req, store, cfg),
      demo: cfg.demo,
      loginReady: !!cfg.clientId && !!cfg.clientSecret,
      pushKey: cfg.vapidPublic,
    }),
  );
  authRoutes(app, store, cfg, (sessionHash) => {
    for (const client of clients.values()) {
      if (client.sessionHash === sessionHash) client.close();
    }
  });
  app.get("/api/items", (req, res) => {
    const from = req.query.from,
      to = req.query.to;
    if (
      !validDate(from) ||
      !validDate(to) ||
      dateDiff(to, from) < 1 ||
      dateDiff(to, from) > 100
    )
      throw new HttpError(400, "조회 기간은 1~100일이어야 합니다.");
    const shared = typeof req.query.share === "string";
    if (shared) {
      if (
        !req.query.share ||
        hash(req.query.share as string) !== store.setting("share_hash")
      )
        throw new HttpError(
          404,
          "공유 링크가 만료되었거나 비활성화되었습니다.",
        );
    } else requireOwner(req, store, cfg);
    const data = store.list(from, to, shared);
    res.json(
      shared
        ? data.map((o) => ({
            id: hash(o.id),
            itemId: hash(o.id),
            key: "single",
            title: o.title,
            notes: o.notes,
            kind: o.kind,
            start: o.start,
            end: o.end,
            public: true,
            done: o.done,
            rule: null,
            reminder: null,
            version: 0,
            recurring: o.recurring,
            seriesStart: null,
          }))
        : data,
    );
  });
  app.use("/api", (req, _res, next) => {
    try {
      requireOwner(req, store, cfg);
      next();
    } catch (e) {
      next(e);
    }
  });
  agentManagement(app, store, cfg);
  app.post("/api/items", (req, res) => {
    const item = store.create(req.body);
    broadcast();
    res.status(201).json(item);
  });
  app.post("/api/items/:id/change", (req, res) => {
    const { key, version, scope, fields, deleting } = req.body;
    if (
      typeof key !== "string" ||
      !Number.isInteger(version) ||
      typeof deleting !== "boolean"
    )
      throw new HttpError(400, "변경 요청을 확인해 주세요.");
    const item = store.mutate(
      String(req.params.id),
      key,
      version,
      scope as Scope,
      fields,
      deleting,
    );
    broadcast();
    res.json(item);
  });
  app.get("/api/trash", (_req, res) => res.json(store.trash()));
  app.post("/api/trash/:id/restore", (req, res) => {
    store.restore(String(req.params.id));
    broadcast();
    res.json({ ok: true });
  });
  app.get("/api/share", (_req, res) =>
    res.json({ active: !!store.setting("share_hash") }),
  );
  app.post("/api/share", (req, res) => {
    if (req.body.action !== "rotate" && req.body.action !== "disable")
      throw new HttpError(400, "공유 설정을 확인해 주세요.");
    const value = req.body.action === "rotate" ? token() : "";
    store.set("share_hash", value ? hash(value) : "");
    broadcast();
    res.json({ url: value ? `${cfg.origin}/s/${value}` : null });
  });
  app.post("/api/push", (req, res) => {
    if (!cfg.vapidPublic || !cfg.vapidPrivate)
      throw new HttpError(503, "알림 서버 설정이 아직 준비되지 않았습니다.");
    res.json({ id: subscribe(store, req.body) });
  });
  app.post("/api/push/remove", (req, res) => {
    if (typeof req.body.endpoint !== "string")
      throw new HttpError(400, "구독 정보가 필요합니다.");
    store.db
      .prepare("DELETE FROM subscriptions WHERE id=?")
      .run(hash(req.body.endpoint));
    res.json({ ok: true });
  });
  app.get("/api/events", (req, res) => {
    res.set({
      "Content-Type": "text/event-stream",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    res.write("event: ready\ndata: {}\n\n");
    const close = () => {
      clearInterval(timer);
      clients.delete(res);
      res.end();
    };
    const timer = setInterval(() => {
      if (!owner(req, store, cfg)) {
        close();
        return;
      }
      res.write(": heartbeat\n\n");
    }, 20000);
    clients.set(res, {
      sessionHash: hash(cookie(req, "plan_session")),
      authorized: () => owner(req, store, cfg),
      close,
    });
    res.on("close", () => {
      clearInterval(timer);
      clients.delete(res);
    });
  });
  app.use("/api", (_req, _res, next) =>
    next(new HttpError(404, "요청을 찾을 수 없습니다.")),
  );
  app.use(express.static(staticDir, { etag: true, index: false }));
  app.get(["/", "/s/:token"], (_req, res) =>
    res.sendFile(resolve(staticDir, "index.html")),
  );
  app.use((_req, _res, next) =>
    next(new HttpError(404, "페이지를 찾을 수 없습니다.")),
  );
  app.use(
    (
      error: unknown,
      req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      if (res.headersSent) return _next(error);
      const status =
        error instanceof HttpError
          ? error.status
          : (error as { type?: string }).type === "entity.too.large"
            ? 413
            : error instanceof SyntaxError
              ? 400
              : 500;
      if (status === 500)
        console.error(error instanceof Error ? error.message : "Server error");
      // Domain validation errors have explicit Korean messages, never expose upstream OAuth/DB details.
      const message =
        error instanceof HttpError
          ? error.message
          : error instanceof Error && /[가-힣]/.test(error.message)
            ? error.message
            : status === 400
              ? "요청 형식이 올바르지 않습니다."
              : "요청을 처리하지 못했습니다. 다시 시도해 주세요.";
      const responseStatus =
        status === 500 &&
        /[가-힣]/.test(message) &&
        error instanceof Error &&
        /[가-힣]/.test(error.message)
          ? 400
          : status;
      res.status(responseStatus);
      // API clients retain JSON regardless of Accept; browser navigations get standalone HTML.
      if (
        req.path !== "/api" &&
        !req.path.startsWith("/api/") &&
        req.path !== "/healthz" &&
        req.accepts(["json", "html"]) === "html"
      ) {
        res.vary("Accept").type("html").send(errorPage(responseStatus));
        return;
      }
      res.json({ error: message });
    },
  );
  return {
    app,
    close: () => {
      for (const c of clients.values()) c.close();
    },
  };
}
