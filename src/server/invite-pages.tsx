import { Actions, LoginCard, LoginPage, RightIcon, renderPage } from "./page-shell.js";

export function renderInvitePrompt(inviterEmail: string, loginHref: string) {
  return renderPage({
    title: "초대 · 하루의 계획",
    children: (
      <LoginPage>
        <LoginCard>
          <span className="eyebrow">초대</span>
          <h1>{inviterEmail}님이 초대했어요</h1>
          <p>Google 계정으로 가입하면 나만의 독립된 일정을 시작할 수 있어요.</p>
          <Actions>
            <a className="primary" href={loginHref}>
              Google로 가입하기 <RightIcon />
            </a>
          </Actions>
        </LoginCard>
      </LoginPage>
    ),
  });
}
