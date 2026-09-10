import { randomUUID } from "node:crypto";
import { Router, type Request, type Response, type Express } from "express";
import { hash, token, requireOwner } from "./auth.js";
import { Store, HttpError } from "./store.js";
import type { Config } from "./config.js";
import {
  DAY,
  validDate,
  dateDiff,
  atDate,
  validKey,
  type Scope,
  type Fields,
} from "../shared/domain.js";
import { agentSchema } from "./agent-schema.js";

const scopes = ["items:read", "items:write", "items:delete"] as const;
type AgentScope = (typeof scopes)[number];
interface KeyRow {
  id: string;
  name: string;
  token_hash: string;
  scopes: string;
  owner_email: string;
  owner_sub: string | null;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
  last_used_at: number | null;
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HttpError(400, "JSON 객체가 필요합니다.");
  return value as Record<string, unknown>;
};
const only = (body: Record<string, unknown>, allowed: string[]) => {
  if (Object.keys(body).some((k) => !allowed.includes(k)))
    throw new HttpError(400, "지원하지 않는 필드가 포함되어 있습니다.");
};
function metadata(k: KeyRow) {
  return {
    id: k.id,
    name: k.name,
    scopes: JSON.parse(k.scopes),
    createdAt: new Date(k.created_at).toISOString(),
    expiresAt: new Date(k.expires_at).toISOString(),
    revokedAt: k.revoked_at ? new Date(k.revoked_at).toISOString() : null,
    lastUsedAt: k.last_used_at ? new Date(k.last_used_at).toISOString() : null,
  };
}

// Management stays on the cookie-authenticated, same-origin API, never the bearer router.
export function agentManagement(app: Express, store: Store, cfg: Config) {
  app.use("/api/agent-keys", (req, _res, next) => {
    requireOwner(req, store, cfg);
    if (req.headers.authorization)
      throw new HttpError(
        403,
        "키 관리는 소유자 브라우저 세션으로만 가능합니다.",
      );
    next();
  });
  app.get("/api/agent-keys", (_req, res) => {
    const rows = store.db
      .prepare("SELECT * FROM agent_keys ORDER BY created_at DESC")
      .all() as unknown as KeyRow[];
    res.json({ keys: rows.map(metadata) });
  });
  app.post("/api/agent-keys", (req, res) => {
    const body = object(req.body);
    only(body, ["name", "scopes", "expiresInDays"]);
    if (!cfg.demo && !store.setting("owner_sub"))
      throw new HttpError(409, "먼저 소유자 Google 계정으로 로그인해 주세요.");
    const days = body.expiresInDays ?? 90;
    if (
      typeof body.name !== "string" ||
      !body.name.trim() ||
      body.name.length > 80 ||
      !Number.isInteger(days) ||
      Number(days) < 1 ||
      Number(days) > 365 ||
      !Array.isArray(body.scopes) ||
      !body.scopes.length ||
      body.scopes.length > 3 ||
      !body.scopes.includes("items:read") ||
      !body.scopes.every((s) => scopes.includes(s))
    )
      throw new HttpError(
        400,
        "이름, 권한과 만료 기간을 확인해 주세요. 읽기 권한은 필수이고 만료는 1~365일입니다.",
      );
    const active = store.db
      .prepare(
        "SELECT count(*) AS n FROM agent_keys WHERE revoked_at IS NULL AND expires_at>?",
      )
      .get(Date.now())!;
    if (Number(active.n) >= 20)
      throw new HttpError(
        409,
        "활성 키는 최대 20개입니다. 사용하지 않는 키를 폐기해 주세요.",
      );
    const secret = `plan_agent_${token()}`,
      now = Date.now();
    const row: KeyRow = {
      id: randomUUID(),
      name: body.name.trim(),
      token_hash: hash(secret),
      scopes: JSON.stringify([...new Set(body.scopes)]),
      owner_email: cfg.owner.toLowerCase(),
      owner_sub: store.setting("owner_sub"),
      created_at: now,
      expires_at: now + Number(days) * DAY,
      revoked_at: null,
      last_used_at: null,
    };
    store.db
      .prepare("INSERT INTO agent_keys VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(
        row.id,
        row.name,
        row.token_hash,
        row.scopes,
        row.owner_email,
        row.owner_sub,
        row.created_at,
        row.expires_at,
        null,
        null,
      );
    res.status(201).json({ ...metadata(row), token: secret });
  });
  app.post("/api/agent-keys/:id/revoke", (req, res) => {
    only(object(req.body), []);
    const result = store.db
      .prepare(
        "UPDATE agent_keys SET revoked_at=coalesce(revoked_at,?) WHERE id=?",
      )
      .run(Date.now(), String(req.params.id));
    if (!result.changes) throw new HttpError(404, "키를 찾을 수 없습니다.");
    res.json({ ok: true });
  });
  app.get("/api/agent-keys/audit", (_req, res) => {
    res.json({
      events: store.db
        .prepare(
          "SELECT id,key_id AS keyId,method,action,status,created_at AS createdAt FROM agent_audit ORDER BY created_at DESC LIMIT 100",
        )
        .all(),
    });
  });
}

export function agentRouter(store: Store, cfg: Config, broadcast: () => void) {
  const router = Router();
  const buckets = new Map<string, { count: number; reset: number }>();
  function limit(id: string, max: number, res: Response) {
    const now = Date.now();
    let b = buckets.get(id);
    if (!b || b.reset <= now) {
      b = { count: 0, reset: now + 60000 };
      buckets.delete(id);
      buckets.set(id, b);
    }
    if (buckets.size > 1024) buckets.delete(buckets.keys().next().value!);
    if (++b.count > max) {
      res.set(
        "Retry-After",
        String(Math.max(1, Math.ceil((b.reset - now) / 1000))),
      );
      throw new HttpError(
        429,
        "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
      );
    }
  }
  router.use((req, res, next) => {
    // No cookies, URL credentials, or demo bypass; a valid key is always mandatory here.
    const header = req.headers.authorization;
    const raw =
      typeof header === "string" &&
      /^Bearer plan_agent_[A-Za-z0-9_-]{43}$/.test(header)
        ? header.slice(7)
        : null;
    const key = raw
      ? (store.db
          .prepare("SELECT * FROM agent_keys WHERE token_hash=?")
          .get(hash(raw)) as unknown as KeyRow | undefined)
      : undefined;
    if (
      !key ||
      key.revoked_at !== null ||
      key.expires_at <= Date.now() ||
      key.owner_email !== cfg.owner.toLowerCase() ||
      key.owner_sub !== store.setting("owner_sub") ||
      (!cfg.demo && !key.owner_sub)
    ) {
      limit(`ip:${req.socket.remoteAddress || "unknown"}`, 30, res);
      res.set("WWW-Authenticate", 'Bearer realm="plan-agent"');
      throw new HttpError(401, "유효한 에이전트 API 키가 필요합니다.");
    }
    limit(`key:${key.id}`, 120, res);
    if (req.headers.origin && req.headers.origin !== cfg.origin)
      throw new HttpError(403, "허용되지 않은 Origin입니다.");
    if (
      ["token", "api_key", "access_token"].some(
        (p) => req.query[p] !== undefined,
      )
    )
      throw new HttpError(
        400,
        "API 키는 Authorization 헤더로만 전달해 주세요.",
      );
    const requestId = randomUUID();
    res.set("X-Request-Id", requestId);
    res.locals.agent = key;
    store.db
      .prepare("UPDATE agent_keys SET last_used_at=? WHERE id=?")
      .run(Date.now(), key.id);
    res.on("finish", () => {
      // Route patterns only: no tokens, request bodies, titles, notes or raw URL/query values.
      const action =
        typeof req.route?.path === "string" ? req.route.path : "unknown";
      store.db
        .prepare("INSERT INTO agent_audit VALUES(?,?,?,?,?,?)")
        .run(requestId, key.id, req.method, action, res.statusCode, Date.now());
    });
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      !req.is("application/json")
    )
      throw new HttpError(415, "Content-Type은 application/json이어야 합니다.");
    next();
  });
  const need = (res: Response, scope: AgentScope) => {
    const key = res.locals.agent as KeyRow;
    if (!(JSON.parse(key.scopes) as string[]).includes(scope))
      throw new HttpError(403, `필요한 권한: ${scope}`);
    return key;
  };
  function mutation(
    req: Request,
    res: Response,
    scope: AgentScope,
    fn: () => { status: number; data: unknown },
  ) {
    const key = need(res, scope),
      id = req.headers["idempotency-key"];
    if (typeof id !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(id))
      throw new HttpError(
        400,
        "변경 요청에는 8~128자의 Idempotency-Key 헤더가 필요합니다.",
      );
    const canonical = (value: unknown, depth = 0): unknown => {
      if (depth > 16)
        throw new HttpError(400, "요청의 중첩 깊이가 너무 큽니다.");
      return Array.isArray(value)
        ? value.map((v) => canonical(v, depth + 1))
        : value && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([k, v]) => [k, canonical(v, depth + 1)]),
            )
          : value;
    };
    const fingerprint = hash(
      JSON.stringify(canonical([req.method, req.path, req.body])),
    );
    let replayed = false;
    const result = store.transaction(() => {
      const existing = store.db
        .prepare(
          "SELECT * FROM agent_requests WHERE key_id=? AND request_key=?",
        )
        .get(key.id, id);
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          throw new HttpError(
            409,
            "같은 Idempotency-Key를 다른 요청에 사용할 수 없습니다.",
          );
        replayed = true;
        return {
          status: Number(existing.status),
          data: JSON.parse(existing.response as string),
        };
      }
      const result = fn();
      store.db
        .prepare("INSERT INTO agent_requests VALUES(?,?,?,?,?,?)")
        .run(
          key.id,
          id,
          fingerprint,
          result.status,
          JSON.stringify(result.data),
          Date.now(),
        );
      return result;
    });
    if (!replayed) broadcast();
    res
      .set("Idempotency-Replayed", String(replayed))
      .status(result.status)
      .json(result.data);
  }
  function identity(body: Record<string, unknown>) {
    if (
      typeof body.key !== "string" ||
      !Number.isInteger(body.version) ||
      Number(body.version) < 1 ||
      typeof body.scope !== "string" ||
      !["one", "future", "all"].includes(body.scope)
    )
      throw new HttpError(
        400,
        "key, 양수 version, scope(one/future/all)가 필요합니다.",
      );
    return {
      key: body.key,
      version: Number(body.version),
      scope: body.scope as Scope,
    };
  }
  router.get("/me", (_req, res) => {
    const key = need(res, "items:read");
    res.json({
      key: metadata(key),
      timezone: "Asia/Seoul",
      timeStorage: "UTC",
      apiVersion: "1",
    });
  });
  router.get("/openapi.json", (_req, res) => {
    need(res, "items:read");
    res.json(agentSchema(cfg.origin));
  });
  router.get("/items", (req, res) => {
    need(res, "items:read");
    const { from, to } = req.query;
    if (
      !validDate(from) ||
      !validDate(to) ||
      dateDiff(to, from) < 1 ||
      dateDiff(to, from) > 100
    )
      throw new HttpError(
        400,
        "from/to는 날짜이며 조회 기간은 1~100일이어야 합니다.",
      );
    const parse = (v: unknown, defaultValue: number, max: number) => {
      if (v === undefined) return defaultValue;
      if (typeof v !== "string" || !/^\d{1,7}$/.test(v) || Number(v) > max)
        throw new HttpError(400, "페이지 범위를 확인해 주세요.");
      return Number(v);
    };
    const limit = parse(req.query.limit, 100, 500),
      offset = parse(req.query.offset, 0, 1000000);
    if (limit < 1) throw new HttpError(400, "limit은 1 이상이어야 합니다.");
    const all = store.list(from, to);
    res.json({
      items: all.slice(offset, offset + limit),
      nextOffset: offset + limit < all.length ? offset + limit : null,
      total: all.length,
      timezone: "Asia/Seoul",
    });
  });
  router.get("/items/:id", (req, res) => {
    need(res, "items:read");
    const item = store.item(String(req.params.id));
    if (item.deletedAt) throw new HttpError(404, "삭제된 일정입니다.");
    res.json({ item });
  });
  router.post("/items", (req, res) =>
    mutation(req, res, "items:write", () => ({
      status: 201,
      data: { item: store.create(req.body) },
    })),
  );
  router.patch("/items/:id", (req, res) =>
    mutation(req, res, "items:write", () => {
      const body = object(req.body);
      only(body, ["key", "version", "scope", "changes"]);
      const { key, version, scope } = identity(body),
        changes = object(body.changes);
      only(changes, [
        "title",
        "notes",
        "kind",
        "start",
        "end",
        "public",
        "done",
        "reminder",
        "rule",
      ]);
      if (!Object.keys(changes).length)
        throw new HttpError(400, "변경할 필드를 지정해 주세요.");
      const item = store.item(String(req.params.id));
      if (item.deletedAt || !validKey(item, key))
        throw new HttpError(404, "회차를 찾을 수 없습니다.");
      const override = store
        .overrides()
        .find((o) => o.itemId === item.id && o.key === key);
      if (override?.deletedAt) throw new HttpError(404, "삭제된 회차입니다.");
      if (item.rule && scope === "one" && "rule" in changes)
        throw new HttpError(
          400,
          "반복 규칙 변경은 future 또는 all 범위에서 가능합니다.",
        );
      const fields = {
        ...atDate(item, key),
        ...override?.patch,
        ...changes,
      } as Fields;
      const updated = store.mutate(item.id, key, version, scope, fields);
      return { status: 200, data: { item: updated, refreshRequired: true } };
    }),
  );
  router.delete("/items/:id", (req, res) =>
    mutation(req, res, "items:delete", () => {
      const body = object(req.body);
      only(body, ["key", "version", "scope"]);
      const { key, version, scope } = identity(body);
      store.mutate(String(req.params.id), key, version, scope, null, true);
      return { status: 200, data: { ok: true, refreshRequired: true } };
    }),
  );
  router.get("/trash", (_req, res) => {
    need(res, "items:read");
    res.json({ items: store.trash() });
  });
  router.post("/trash/:id/restore", (req, res) =>
    mutation(req, res, "items:write", () => {
      only(object(req.body), []);
      store.restore(String(req.params.id));
      return { status: 200, data: { ok: true } };
    }),
  );
  router.use((_req, _res, next) =>
    next(new HttpError(404, "에이전트 API 경로를 찾을 수 없습니다.")),
  );
  return router;
}
