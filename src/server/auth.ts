import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { OAuth2Client, CodeChallengeMethod } from "google-auth-library";
import type { Express, Request, Response } from "express";
import type { Config } from "./config.js";
import { Store, HttpError } from "./store.js";
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
export function owner(req: Request, store: Store, cfg: Config) {
  if (cfg.demo) return true;
  const row = store.db
    .prepare("SELECT expires FROM sessions WHERE hash=?")
    .get(hash(cookie(req, "plan_session")));
  return !!row && Number(row.expires) > Date.now();
}
export const requireOwner = (req: Request, store: Store, cfg: Config) => {
  if (!owner(req, store, cfg)) throw new HttpError(401, "로그인이 필요합니다.");
};
export function authRoutes(
  app: Express,
  store: Store,
  cfg: Config,
  revokeSession: (sessionHash: string) => void = () => {},
) {
  // Global limits suit this single-owner app and cannot be bypassed with proxy headers.
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
  app.get("/auth/google", async (_req, res) => {
    limit("start", 5, res);
    if (!cfg.clientId || !cfg.clientSecret)
      throw new HttpError(
        503,
        "Google 로그인 설정이 아직 준비되지 않았습니다.",
      );
    const state = token(),
      nonce = token(),
      verifier = token();
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
          JSON.stringify({ nonce, verifier }),
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
    const { nonce, verifier } = JSON.parse(row.data as string);
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
    if (
      !p ||
      !p.email_verified ||
      p.email?.toLowerCase() !== cfg.owner.toLowerCase() ||
      (p as unknown as { nonce: string }).nonce !== nonce
    )
      throw new HttpError(403, "이 계정에는 편집 권한이 없습니다.");
    const subject = store.setting("owner_sub");
    if (subject && subject !== p.sub)
      throw new HttpError(403, "등록된 소유자 계정과 일치하지 않습니다.");
    store.set("owner_sub", p.sub);
    const session = token();
    store.db
      .prepare("INSERT INTO sessions VALUES(?,?)")
      .run(hash(session), Date.now() + 30 * 86400000);
    res.cookie("plan_session", session, { ...options, maxAge: 30 * 86400000 });
    res.redirect("/");
  });
  app.post("/api/logout", (req, res) => {
    const sessionHash = hash(cookie(req, "plan_session"));
    store.db.prepare("DELETE FROM sessions WHERE hash=?").run(sessionHash);
    revokeSession(sessionHash);
    res.clearCookie("plan_session", options);
    res.json({ ok: true });
  });
}
