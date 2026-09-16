import {
  Actions,
  LockIcon,
  LoginCard,
  LoginPage,
  RightIcon,
  renderPage,
} from "./page-shell.js";

const scopeNames: Record<string, string> = {
  "items:read": "비공개 일정·메모·휴지통 읽기",
  "items:write": "일정 등록·수정·완료·복구",
  "items:delete": "일정 삭제 (휴지통으로 이동)",
};

export function renderLoginPrompt(returnTo: string) {
  return renderPage({
    title: "ChatGPT 연결 · 하루의 계획",
    children: (
      <LoginPage>
        <LoginCard>
          <span className="eyebrow">ChatGPT 연결</span>
          <h1>소유자로 로그인해 주세요</h1>
          <p>
            하루의 계획 소유자 Google 계정으로 로그인한 뒤 연결을 승인할 수
            있어요.
          </p>
          <a className="primary login-button" href={returnTo}>
            Google로 로그인 <RightIcon />
          </a>
          <span className="login-note">
            <LockIcon size={14} />
            소유자만 승인할 수 있습니다.
          </span>
        </LoginCard>
      </LoginPage>
    ),
  });
}

export function renderConsent(opts: {
  clientName: string;
  redirectOrigin: string;
  ticket: string;
  csrf: string;
  scopes: string[];
}) {
  return renderPage({
    title: "연결 승인 · 하루의 계획",
    children: (
      <LoginPage>
        <LoginCard>
          <span className="eyebrow">ChatGPT 연결 승인</span>
          <h1>연결을 승인할까요?</h1>
          <p>클라이언트: {opts.clientName}</p>
          <p className="field-hint">
            이름은 클라이언트가 제공한 정보입니다. 승인 후 {opts.redirectOrigin}
            으로 돌아갑니다. 연결은 별도 유효기한 없이 유지되며 설정 → MCP
            연결에서 언제든 폐기할 수 있습니다.
          </p>
          <form method="post" action="/mcp/connect">
            <input type="hidden" name="ticket" value={opts.ticket} />
            <input type="hidden" name="csrf" value={opts.csrf} />
            <fieldset className="scope">
              <legend>요청 권한</legend>
              {opts.scopes.map((s) => (
                <label key={s}>
                  <input
                    type="checkbox"
                    name="scope"
                    value={s}
                    defaultChecked={s === "items:read"}
                    disabled={s === "items:read"}
                  />
                  {scopeNames[s] ?? s}
                </label>
              ))}
            </fieldset>
            <p className="field-hint">
              등록·수정·삭제 권한은 필요한 경우에만 선택하세요.
            </p>
            <Actions>
              <button className="primary" name="decision" value="approve">
                연결 승인
              </button>
              <button name="decision" value="deny">
                취소
              </button>
            </Actions>
          </form>
        </LoginCard>
      </LoginPage>
    ),
  });
}

export function renderRedirecting(targetHref: string) {
  return renderPage({
    title: "ChatGPT로 돌아가는 중 · 하루의 계획",
    refresh: targetHref,
    children: (
      <LoginPage>
        <LoginCard>
          <span className="eyebrow">ChatGPT 연결</span>
          <h1>ChatGPT로 돌아가는 중…</h1>
          <p>자동으로 이동하지 않으면 아래 링크를 눌러주세요.</p>
          <a className="primary login-button" href={targetHref}>
            계속하기 <RightIcon />
          </a>
        </LoginCard>
      </LoginPage>
    ),
  });
}
