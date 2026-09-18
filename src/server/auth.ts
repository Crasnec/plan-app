import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { OAuth2Client, CodeChallengeMethod } from "google-auth-library";
import type { Express, Request, Response } from "express";
import type { Config } from "./config.js";
import { Store, HttpError, type User } from "./store.js";
import { touchSession } from "./session-info.js";
import { sessionRoutes } from "./sessions.js";
import { errorPage } from "./error-page.js";
import { renderInvitePrompt } from "./invite-pages.js";
export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export const token = () => randomBytes(32).toString("base64url");
export function cookie(req: Request, name: string) {
  return (
    req.headers.cookie
      ?.split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith(`${name}=`))
      ?.slice(name.length + 1) || ""
  );
}
const DAY = 86400000;
const INVITE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
// Demo mode simulates one always-logged-in tenant with no real Google login.
function demoUser(store: Store): User {
  return store.userBySub("demo") || store.createUser("demo@localhost", "demo");
}
export function currentUser(
  req: Request,
  store: Store,
  cfg: Config,
): User | null {
  if (cfg.demo) return demoUser(store);
  const sessionHash = hash(cookie(req, "plan_session"));
  const row = store.db
    .prepare("SELECT user_id, expires FROM sessions WHERE hash=?")
    .get(sessionHash) as { user_id: string | null; expires: number } | undefined;
  if (!row || Number(row.expires) <= Date.now() || !row.user_id) return null;
  const user = store.user(row.user_id);
  if (!user) return null;
  touchSession(store, req, sessionHash);
  return user;
}
export const requireUser = (req: Request, store: Store, cfg: Config): User => {
  const user = currentUser(req, store, cfg);
  if (!user) throw new HttpError(401, "로그인이 필요합니다.");
  return user;
};
export function authRoutes(
  app: Express,
  store: Store,
  cfg: Config,
  revokeSession: (sessionHash: string) => void = () => {},
) {
  // Global limits suit today's small user base and cannot be bypassed with proxy headers.
  const limits = new Map<string, { until: number; count: number }>();
  const limit = (name: string, max: number, res: Response) => {
    const now = Date.now();
    let bucket = limits.get(name);
    if (!bucket || bucket.until <= now) {
      bucket = { until: now + 60000, count: 0 };
      limits.set(name, bucket);
    }
    if (++bucket.count > max) {
      res.setHeader("Retry-After", Math.ceil((bucket.until - now) / 1000));
      throw new HttpError(
        429,
        "로그인 요청이 많습니다. 잠시 후 다시 시도해 주세요.",
      );
    }
  };
  const oauth = new OAuth2Client(
    cfg.clientId,
    cfg.clientSecret,
    `${cfg.origin}/auth/google/callback`,
  );
  const options = {
    httpOnly: true,
    secure: cfg.origin.startsWith("https:"),
    sameSite: "lax" as const,
    path: "/",
  };
  app.get("/invite/:token", (req, res) => {
    const raw = String(req.params.token);
    if (!INVITE_TOKEN.test(raw))
      throw new HttpError(404, "초대 링크를 찾을 수 없습니다.");
    const invite = store.db
      .prepare("SELECT * FROM invites WHERE token_hash=?")
      .get(hash(raw));
    if (!invite || invite.revoked_at || Number(invite.expires_at) <= Date.now())
      throw new HttpError(
        404,
        "초대 링크가 만료되었거나 취소되었습니다.",
      );
    const inviter = store.user(String(invite.created_by));
    res
      .type("html")
      .send(
        renderInvitePrompt(
          inviter?.email ?? "다른 사용자",
          `/auth/google?invite=${raw}`,
        ),
      );
  });
  app.get("/auth/google", async (req, res) => {
    limit("start", 5, res);
    if (!cfg.clientId || !cfg.clientSecret)
      throw new HttpError(
        503,
        "Google 로그인 설정이 아직 준비되지 않았습니다.",
      );
    const state = token(),
      nonce = token(),
      verifier = token();
    const returnTo =
      typeof req.query.returnTo === "string" &&
      /^\/mcp\/connect\?ticket=[A-Za-z0-9_-]{43}$/.test(req.query.returnTo)
        ? req.query.returnTo
        : "/";
    const invite =
      typeof req.query.invite === "string" && INVITE_TOKEN.test(req.query.invite)
        ? req.query.invite
        : null;
    store.transaction(() => {
      store.db.prepare("DELETE FROM oauth WHERE expires<=?").run(Date.now());
      if (
        Number(store.db.prepare("SELECT count(*) AS n FROM oauth").get()!.n) >=
        100
      ) {
        res.setHeader("Retry-After", "60");
        throw new HttpError(429, "진행 중인 로그인 요청이 많습니다.");
      }
      store.db
        .prepare("INSERT INTO oauth VALUES(?,?,?)")
        .run(
          hash(state),
          Date.now() + 600000,
          JSON.stringify({ nonce, verifier, returnTo, invite }),
        );
    });
    res.cookie("plan_oauth", state, { ...options, maxAge: 600000 });
    res.redirect(
      oauth.generateAuthUrl({
        scope: ["openid", "email"],
        state,
        nonce,
        code_challenge: createHash("sha256")
          .update(verifier)
          .digest("base64url"),
        code_challenge_method: CodeChallengeMethod.S256,
        prompt: "select_account",
      }),
    );
  });
  app.get("/auth/google/callback", async (req, res) => {
    limit("callback", 20, res);
    const state = typeof req.query.state === "string" ? req.query.state : "",
      saved = cookie(req, "plan_oauth");
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(state) ||
      !/^[A-Za-z0-9_-]{43}$/.test(saved) ||
      !timingSafeEqual(Buffer.from(state), Buffer.from(saved))
    )
      throw new HttpError(
        400,
        "로그인 요청이 만료되었습니다. 다시 로그인해 주세요.",
      );
    const row = store.db
      .prepare("SELECT * FROM oauth WHERE hash=?")
      .get(hash(state));
    store.db.prepare("DELETE FROM oauth WHERE hash=?").run(hash(state));
    res.clearCookie("plan_oauth", options);
    if (
      !row ||
      Number(row.expires) < Date.now() ||
      typeof req.query.code !== "string"
    )
      throw new HttpError(400, "로그인을 완료하지 못했습니다.");
    const { nonce, verifier, returnTo, invite } = JSON.parse(
      row.data as string,
    );
    const { tokens } = await oauth.getToken({
      code: req.query.code,
      codeVerifier: verifier,
    });
    if (!tokens.id_token)
      throw new HttpError(401, "인증 정보를 확인할 수 없습니다.");
    const ticket = await oauth.verifyIdToken({
      idToken: tokens.id_token,
      audience: cfg.clientId,
    });
    const p = ticket.getPayload();
    if (!p || !p.email_verified || (p as unknown as { nonce: string }).nonce !== nonce)
      throw new HttpError(403, "로그인 요청을 확인할 수 없습니다.");
    let user = store.userBySub(p.sub!);
    if (!user) {
      const noUsersYet = !store.db.prepare("SELECT 1 FROM users LIMIT 1").get();
      const founding = noUsersYet && p.email!.toLowerCase() === cfg.owner.toLowerCase();
      const inviteToken =
        typeof invite === "string" && INVITE_TOKEN.test(invite) ? invite : null;
      const inviteRow = inviteToken
        ? (store.db
            .prepare("SELECT * FROM invites WHERE token_hash=?")
            .get(hash(inviteToken)) as
            | {
                id: string;
                revoked_at: number | null;
                expires_at: number;
              }
            | undefined)
        : undefined;
      // Invite links are reusable by design: any number of people may sign up
      // through the same link until it expires or is explicitly revoked.
      const inviteValid =
        inviteRow &&
        !inviteRow.revoked_at &&
        Number(inviteRow.expires_at) > Date.now();
      if (!founding && !inviteValid) {
        res.status(403).type("html").send(errorPage(403));
        return;
      }
      user = store.transaction(() => {
        const created = store.createUser(p.email!.toLowerCase(), p.sub!);
        if (inviteValid)
          store.db
            .prepare("INSERT OR IGNORE INTO invite_uses VALUES(?,?,?)")
            .run(inviteRow!.id, created.id, Date.now());
        return created;
      });
    }
    const session = token();
    store.db
      .prepare("INSERT INTO sessions VALUES(?,?,?)")
      .run(hash(session), Date.now() + 30 * DAY, user.id);
    touchSession(store, req, hash(session), Date.now());
    res.cookie("plan_session", session, { ...options, maxAge: 30 * DAY });
    res.redirect(
      typeof returnTo === "string" &&
        /^\/mcp\/connect\?ticket=[A-Za-z0-9_-]{43}$/.test(returnTo)
        ? returnTo
        : "/",
    );
  });
  sessionRoutes(app, store, cfg, revokeSession, (res) => {
    res.clearCookie("plan_session", options);
  });
  app.post("/api/account/withdraw", (req, res) => {
    const user = requireUser(req, store, cfg);
    if (cfg.demo || req.headers.authorization)
      throw new HttpError(403, "회원 탈퇴는 본인 브라우저에서만 가능합니다.");
    if (!req.body || req.body.confirmation !== "회원 탈퇴" || Object.keys(req.body).length !== 1)
      throw new HttpError(400, "회원 탈퇴 확인 문구를 입력해 주세요.");
    for (const sessionHash of store.withdrawUser(user.id)) revokeSession(sessionHash);
    res.clearCookie("plan_session", options);
    res.clearCookie("plan_oauth", options);
    res.json({ ok: true });
  });
  app.post("/api/logout", (req, res) => {
    const sessionHash = hash(cookie(req, "plan_session"));
    store.db.prepare("DELETE FROM sessions WHERE hash=? AND user_id NOT IN (SELECT id FROM users WHERE deleted_at IS NOT NULL)").run(sessionHash);
    revokeSession(sessionHash);
    res.clearCookie("plan_session", options);
    res.json({ ok: true });
  });
}
