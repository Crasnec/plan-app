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
import { cookie, currentUser, hash, token } from "./auth.js";
import { Store, HttpError } from "./store.js";
import type { Config } from "./config.js";
import {
  renderConsent,
  renderLoginPrompt,
  renderRedirecting,
} from "./mcp-pages.js";

export const mcpScopes = ["items:read", "items:write", "items:delete"];
const FOREVER = 8640000000000000; // Storage sentinel, never exposed as a connection expiry.
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
    if (!row) return undefined;
    const data = JSON.parse(row.data as string);
    if (data.keyId) {
      const key = this.store.db.prepare("SELECT user_id FROM agent_keys WHERE id=?").get(data.keyId);
      if (!key || !this.store.user(String(key.user_id))) return undefined;
    }
    if (data.session) {
      const session = this.store.db.prepare("SELECT user_id FROM sessions WHERE hash=?").get(data.session);
      if (session && !this.store.user(String(session.user_id))) return undefined;
    }
    return data as T;
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
      .prepare("DELETE FROM mcp_oauth WHERE coalesce(json_extract(data,'$.keyId'),'') NOT IN (SELECT k.id FROM agent_keys k JOIN users u ON u.id=k.user_id WHERE u.deleted_at IS NOT NULL) AND coalesce(json_extract(data,'$.session'),'') NOT IN (SELECT s.hash FROM sessions s JOIN users u ON u.id=s.user_id WHERE u.deleted_at IS NOT NULL) AND expires<=?")
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
      !key.user_id ||
      !this.store.user(String(key.user_id)) ||
      !this.store.db
        .prepare("SELECT 1 FROM mcp_connections WHERE key_id=?")
        .get(grant.keyId) ||
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
    this.key(grant);
    const access = token(),
      refresh = token();
    const expires = Date.now() + 3600000;
    this.put(hash(access), "access", grant, expires);
    this.put(hash(refresh), "refresh", grant, FOREVER);
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
      this.key(grant);
      if (scopes?.some((s) => !grant.scopes.includes(s)))
        throw new InvalidScopeError("Scope escalation is not permitted.");
      this.put(hash(raw), "used_refresh", grant, FOREVER);
      return this.issue({ ...grant, scopes: scopes ?? grant.scopes });
    });
  }
  async verifyAccessToken(raw: string) {
    const grant = this.read<Grant>(hash(raw), "access");
    if (!grant) throw new InvalidTokenError("Invalid access token.");
    const key = this.key(grant);
    return {
      token: raw,
      clientId: grant.clientId,
      scopes: grant.scopes,
      resource: new URL(grant.resource),
      extra: { keyId: grant.keyId, userId: String(key.user_id) },
    };
  }
  revokeGrant(grant: Grant) {
    this.store.db
      .prepare("UPDATE agent_keys SET revoked_at=? WHERE id=?")
      .run(Date.now(), grant.keyId);
    this.store.db
      .prepare(
        "DELETE FROM mcp_oauth WHERE kind IN ('code','access','refresh','used_refresh') AND json_extract(data,'$.keyId')=?",
      )
      .run(grant.keyId);
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
      const user = currentUser(req, this.store, this.cfg);
      if (!user) {
        const returnTo = `/auth/google?returnTo=${encodeURIComponent(`/mcp/connect?ticket=${ticket}`)}`;
        res.type("html").send(renderLoginPrompt(returnTo));
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
      res.type("html").send(
        renderConsent({
          clientName: client.client_name || "MCP 클라이언트",
          redirectOrigin: new URL(pending.redirectUri).origin,
          ticket,
          csrf,
          scopes: pending.scopes,
        }),
      );
    });
    app.post(
      "/mcp/connect",
      express.urlencoded({ extended: false, limit: "8kb" }),
      (req, res) => {
        // A sandboxed/redirected navigation can report an opaque origin as the
        // literal string "null" rather than omitting the header; treat both
        // as "no origin to check" since the CSRF token + session cookie below
        // already bind this submission to the approval that was rendered.
        const originOk =
          !req.headers.origin ||
          req.headers.origin === "null" ||
          req.headers.origin === this.cfg.origin;
        const user = currentUser(req, this.store, this.cfg);
        if (!user || !originOk)
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
                    "SELECT count(*) AS n FROM agent_keys WHERE user_id=? AND revoked_at IS NULL AND expires_at>?",
                  )
                  .get(user.id, Date.now())!.n,
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
              .prepare(
                "INSERT INTO agent_keys VALUES(?,?,?,?,?,?,?,?,?,?,?)",
              )
              .run(
                id,
                "MCP · ChatGPT",
                hash(token()),
                JSON.stringify(scopes),
                user.email,
                user.googleSub,
                Date.now(),
                FOREVER,
                null,
                null,
                user.id,
              );
            this.store.db
              .prepare("INSERT INTO mcp_connections VALUES(?)")
              .run(id);
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
        // The page's CSP sets form-action 'self', which browsers also apply to a
        // 303 Location following a form submit — an HTTP redirect back to the
        // ChatGPT origin here would be silently blocked. A meta-refresh page is a
        // plain navigation, not a form action, so it isn't subject to that check.
        res.type("html").send(renderRedirecting(target.href));
      },
    );
  }
}
