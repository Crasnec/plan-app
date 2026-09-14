import { randomUUID } from "node:crypto";
import express, { type Express, type Response } from "express";
import {
  mcpAuthRouter,
  createOAuthMetadata,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidTokenError,
  InvalidScopeError,
  InvalidTargetError,
  TooManyRequestsError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { cookie, hash, owner, token } from "./auth.js";
import { Store, HttpError } from "./store.js";
import type { Config } from "./config.js";

export const mcpScopes = ["items:read", "items:write", "items:delete"];
type Grant = {
  clientId: string;
  keyId: string;
  scopes: string[];
  resource: string;
};
type Pending = {
  clientId: string;
  redirectUri: string;
  challenge: string;
  scopes: string[];
  state?: string;
  resource: string;
  csrf?: string;
  session?: string;
};
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
function page(body: string) {
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>하루의 계획 · ChatGPT 연결</title><style>body{font:16px/1.7 system-ui;background:#f4f3eb;color:#34432e;margin:0;padding:24px}main{max-width:520px;margin:5vh auto;background:#fffefa;padding:28px;border-radius:20px;overflow-wrap:anywhere}button,a{display:inline-block;padding:12px 20px;border-radius:10px;border:1px solid #a2b393;background:#e3eadb;color:#34432e;margin:8px 8px 0 0}label{display:block;margin:12px 0}small{color:#64755a}</style><main>${body}</main></html>`;
}
export class McpAuth implements OAuthServerProvider {
  readonly resource: string;
  readonly clientsStore: OAuthRegisteredClientsStore;
  constructor(
    readonly store: Store,
    readonly cfg: Config,
  ) {
    this.resource = `${cfg.origin}/mcp`;
    this.clientsStore = {
      getClient: (id) => this.read<OAuthClientInformationFull>(id, "client"),
      registerClient: (metadata) => {
        if (
          metadata.token_endpoint_auth_method !== "none" ||
          metadata.client_secret ||
          !metadata.redirect_uris.length ||
          metadata.redirect_uris.length > 5 ||
          metadata.redirect_uris.some((uri) => !this.allowedRedirect(uri)) ||
          (metadata.client_name?.length ?? 0) > 100
        )
          throw new InvalidClientMetadataError(
            "Use a public PKCE client (none) and an exact ChatGPT HTTPS callback URL.",
          );
        if (
          Number(
            this.store.db
              .prepare(
                "SELECT count(*) AS n FROM mcp_oauth WHERE kind='client'",
              )
              .get()!.n,
          ) >= 100
        )
          throw new TooManyRequestsError("Client registration limit reached.");
        const client = {
          ...metadata,
          client_id: randomUUID(),
          client_id_issued_at: Math.floor(Date.now() / 1000),
        };
        this.put(client.client_id, "client", client, 8.64e15);
        return client;
      },
    };
  }
  allowedRedirect(uri: string) {
    try {
      const u = new URL(uri);
      return (
        u.origin === "https://chatgpt.com" &&
        !u.username &&
        !u.password &&
        !u.search &&
        !u.hash &&
        (u.pathname === "/connector_platform_oauth_redirect" ||
          /^\/connector\/oauth\/[A-Za-z0-9_-]+$/.test(u.pathname))
      );
    } catch {
      return false;
    }
  }
  put(id: string, kind: string, data: unknown, expires: number) {
    this.store.db
      .prepare("INSERT OR REPLACE INTO mcp_oauth VALUES(?,?,?,?)")
      .run(id, kind, expires, JSON.stringify(data));
  }
  read<T>(id: string, kind: string): T | undefined {
    const row = this.store.db
      .prepare("SELECT data FROM mcp_oauth WHERE id=? AND kind=? AND expires>?")
      .get(id, kind, Date.now());
    return row ? (JSON.parse(row.data as string) as T) : undefined;
  }
  remove(id: string) {
    this.store.db.prepare("DELETE FROM mcp_oauth WHERE id=?").run(id);
  }
  checkResource(resource?: URL) {
    if (resource?.href !== this.resource)
      throw new InvalidTargetError(
        "The resource must be this server's /mcp URL.",
      );
  }
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ) {
    this.checkResource(params.resource);
    const scopes = params.scopes?.length ? params.scopes : ["items:read"];
    if (
      !scopes.includes("items:read") ||
      scopes.some((s) => !mcpScopes.includes(s))
    )
      throw new InvalidScopeError("Unsupported scopes.");
    this.store.db
      .prepare("DELETE FROM mcp_oauth WHERE expires<=?")
      .run(Date.now());
    if (
      Number(
        this.store.db
          .prepare("SELECT count(*) AS n FROM mcp_oauth WHERE kind='pending'")
          .get()!.n,
      ) >= 100
    )
      throw new TooManyRequestsError("Too many pending authorizations.");
    const ticket = token();
    this.put(
      hash(ticket),
      "pending",
      {
        clientId: client.client_id,
        redirectUri: params.redirectUri,
        challenge: params.codeChallenge,
        scopes,
        state: params.state,
        resource: this.resource,
      } satisfies Pending,
      Date.now() + 600000,
    );
    res.redirect(`/mcp/connect?ticket=${ticket}`);
  }
  code(client: OAuthClientInformationFull, raw: string) {
    const code = this.read<Grant & { challenge: string; redirectUri: string }>(
      hash(raw),
      "code",
    );
    if (!code || code.clientId !== client.client_id)
      throw new InvalidGrantError("Invalid or expired authorization code.");
    return code;
  }
  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
  ) {
    return this.code(client, code).challenge;
  }
  key(grant: Grant) {
    const key = this.store.db
      .prepare("SELECT * FROM agent_keys WHERE id=?")
      .get(grant.keyId);
    if (
      !key ||
      key.revoked_at !== null ||
      Number(key.expires_at) <= Date.now() ||
      key.owner_email !== this.cfg.owner.toLowerCase() ||
      key.owner_sub !== this.store.setting("owner_sub") ||
      (!this.cfg.demo && !key.owner_sub) ||
      grant.resource !== this.resource ||
      grant.scopes.some(
        (s) => !(JSON.parse(key.scopes as string) as string[]).includes(s),
      )
    )
      throw new InvalidTokenError(
        "Connection expired or revoked. Reconnect from settings.",
      );
    return key;
  }
  issue(grant: Grant): OAuthTokens {
    const key = this.key(grant);
    const access = token(),
      refresh = token();
    const expires = Math.min(Date.now() + 3600000, Number(key.expires_at));
    this.put(hash(access), "access", grant, expires);
    this.put(hash(refresh), "refresh", grant, Number(key.expires_at));
    return {
      access_token: access,
      token_type: "Bearer",
      expires_in: Math.floor((expires - Date.now()) / 1000),
      refresh_token: refresh,
      scope: grant.scopes.join(" "),
    };
  }
  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    raw: string,
    _verifier?: string,
    redirectUri?: string,
    resource?: URL,
  ) {
    this.checkResource(resource);
    return this.store.transaction(() => {
      const code = this.code(client, raw);
      if (code.redirectUri !== redirectUri)
        throw new InvalidGrantError("Redirect URI mismatch.");
      this.remove(hash(raw));
      return this.issue(code);
    });
  }
  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    raw: string,
    scopes?: string[],
    resource?: URL,
  ) {
    this.checkResource(resource);
    const reused = this.read<Grant>(hash(raw), "used_refresh");
    if (reused && reused.clientId === client.client_id) {
      this.revokeGrant(reused);
      throw new InvalidGrantError("Refresh token replay detected. Reconnect.");
    }
    return this.store.transaction(() => {
      const grant = this.read<Grant>(hash(raw), "refresh");
      if (!grant || grant.clientId !== client.client_id)
        throw new InvalidGrantError("Invalid refresh token.");
      const key = this.key(grant);
      if (scopes?.some((s) => !grant.scopes.includes(s)))
        throw new InvalidScopeError("Scope escalation is not permitted.");
      this.put(hash(raw), "used_refresh", grant, Number(key.expires_at));
      return this.issue({ ...grant, scopes: scopes ?? grant.scopes });
    });
  }
  async verifyAccessToken(raw: string) {
    const grant = this.read<Grant>(hash(raw), "access");
    if (!grant) throw new InvalidTokenError("Invalid access token.");
    this.key(grant);
    return {
      token: raw,
      clientId: grant.clientId,
      scopes: grant.scopes,
      resource: new URL(grant.resource),
      extra: { keyId: grant.keyId },
    };
  }
  revokeGrant(grant: Grant) {
    this.store.db
      .prepare("UPDATE agent_keys SET revoked_at=? WHERE id=?")
      .run(Date.now(), grant.keyId);
  }
  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ) {
    for (const kind of ["access", "refresh", "used_refresh"]) {
      const grant = this.read<Grant>(hash(request.token), kind);
      if (grant?.clientId === client.client_id) this.revokeGrant(grant);
    }
  }
  mount(app: Express) {
    const options = {
      provider: this,
      issuerUrl: new URL(this.cfg.origin),
      resourceServerUrl: new URL(this.resource),
      scopesSupported: mcpScopes,
      resourceName: "하루의 계획",
    };
    // Public clients use PKCE; no client secrets are stored or required.
    app.get("/.well-known/oauth-authorization-server", (_req, res) =>
      res.json({
        ...createOAuthMetadata(options),
        token_endpoint_auth_methods_supported: ["none"],
        revocation_endpoint_auth_methods_supported: ["none"],
      }),
    );
    app.get("/.well-known/oauth-protected-resource", (_req, res) =>
      res.json({
        resource: this.resource,
        authorization_servers: [new URL(this.cfg.origin).href],
        scopes_supported: mcpScopes,
      }),
    );
    app.use(mcpAuthRouter(options));
    app.get("/mcp/connect", (req, res) => {
      const ticket =
        typeof req.query.ticket === "string" ? req.query.ticket : "";
      const pending = this.read<Pending>(hash(ticket), "pending");
      if (!pending)
        throw new HttpError(
          400,
          "연결 요청이 만료되었습니다. ChatGPT에서 다시 연결해 주세요.",
        );
      if (!owner(req, this.store, this.cfg)) {
        res
          .type("html")
          .send(
            page(
              `<h1>ChatGPT 연결</h1><p>하루의 계획 소유자 계정으로 로그인한 뒤 연결을 승인하세요.</p><a href="/auth/google?returnTo=${encodeURIComponent(`/mcp/connect?ticket=${ticket}`)}">Google로 로그인</a>`,
            ),
          );
        return;
      }
      const csrf = token();
      this.put(
        hash(ticket),
        "pending",
        {
          ...pending,
          csrf: hash(csrf),
          session: hash(cookie(req, "plan_session")),
        },
        Date.now() + 600000,
      );
      const client = this.read<OAuthClientInformationFull>(
        pending.clientId,
        "client",
      )!;
      const names: Record<string, string> = {
        "items:read": "비공개 일정·메모·휴지통 읽기",
        "items:write": "일정 등록·수정·완료·복구",
        "items:delete": "일정 삭제 (휴지통으로 이동)",
      };
      res
        .type("html")
        .send(
          page(
            `<h1>ChatGPT 연결 승인</h1><p>클라이언트: ${escape(client.client_name || "MCP 클라이언트")}</p><small>이름은 클라이언트가 제공한 정보입니다. 승인 후 ${escape(new URL(pending.redirectUri).origin)}으로 돌아갑니다. 연결은 30일간 유효하며 설정 → API 키 관리에서 폐기할 수 있습니다.</small><form method="post" action="/mcp/connect"><input type="hidden" name="ticket" value="${escape(ticket)}"><input type="hidden" name="csrf" value="${csrf}">${pending.scopes.map((s) => `<label><input type="checkbox" name="scope" value="${s}" ${s === "items:read" ? "checked disabled" : ""}> ${names[s]}</label>`).join("")}<p>등록·수정·삭제 권한은 필요한 경우에만 선택하세요.</p><button name="decision" value="approve">연결 승인</button><button name="decision" value="deny">취소</button></form>`,
          ),
        );
    });
    app.post(
      "/mcp/connect",
      express.urlencoded({ extended: false, limit: "8kb" }),
      (req, res) => {
        if (
          !owner(req, this.store, this.cfg) ||
          req.headers.origin !== this.cfg.origin
        )
          throw new HttpError(403, "허용되지 않은 연결 승인 요청입니다.");
        const ticket =
          typeof req.body.ticket === "string" ? req.body.ticket : "";
        const pending = this.read<Pending>(hash(ticket), "pending");
        if (
          !pending ||
          typeof req.body.csrf !== "string" ||
          pending.csrf !== hash(req.body.csrf) ||
          pending.session !== hash(cookie(req, "plan_session"))
        )
          throw new HttpError(403, "연결 승인 요청이 만료되었습니다.");
        const target = new URL(pending.redirectUri);
        if (pending.state) target.searchParams.set("state", pending.state);
        this.store.transaction(() => {
          if (req.body.decision === "approve") {
            const selected: unknown[] = Array.isArray(req.body.scope)
              ? req.body.scope
              : req.body.scope
                ? [req.body.scope]
                : [];
            if (
              selected.some(
                (s) => typeof s !== "string" || !pending.scopes.includes(s),
              )
            )
              throw new HttpError(400, "요청한 범위 밖의 권한입니다.");
            if (
              Number(
                this.store.db
                  .prepare(
                    "SELECT count(*) AS n FROM agent_keys WHERE revoked_at IS NULL AND expires_at>?",
                  )
                  .get(Date.now())!.n,
              ) >= 20
            )
              throw new HttpError(
                409,
                "활성 연결·API 키는 최대 20개입니다. 사용하지 않는 연결을 폐기해 주세요.",
              );
            const scopes = [
              ...new Set(["items:read", ...(selected as string[])]),
            ];
            const id = randomUUID();
            this.store.db
              .prepare("INSERT INTO agent_keys VALUES(?,?,?,?,?,?,?,?,?,?)")
              .run(
                id,
                "MCP · ChatGPT",
                hash(token()),
                JSON.stringify(scopes),
                this.cfg.owner.toLowerCase(),
                this.store.setting("owner_sub"),
                Date.now(),
                Date.now() + 30 * 86400000,
                null,
                null,
              );
            const raw = token();
            this.put(
              hash(raw),
              "code",
              { ...pending, keyId: id, scopes },
              Date.now() + 60000,
            );
            target.searchParams.set("code", raw);
          } else target.searchParams.set("error", "access_denied");
          this.remove(hash(ticket));
        });
        res.redirect(303, target.href);
      },
    );
  }
}
