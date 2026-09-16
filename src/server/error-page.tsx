import { Actions, LoginCard, LoginPage, RightIcon, renderPage } from "./page-shell.js";

const copy: Record<number, [string, string]> = {
  400: [
    "요청을 다시 확인해 주세요",
    "로그인 요청이 만료되었거나 올바르지 않습니다. 홈으로 돌아가 다시 시도해 주세요.",
  ],
  401: [
    "로그인이 필요해요",
    "이 화면을 보려면 소유자 계정으로 로그인해 주세요.",
  ],
  403: [
    "편집 권한이 없는 계정이에요",
    "일정 편집은 등록된 소유자만 할 수 있어요. 다른 Google 계정으로 로그인하거나, 전달받은 공유 링크에서 공개된 일정을 확인해 주세요.",
  ],
  404: [
    "페이지를 찾을 수 없어요",
    "주소가 바뀌었거나 더 이상 사용할 수 없는 페이지예요. 공유 링크라면 소유자에게 새 링크를 요청해 주세요.",
  ],
  413: ["요청이 너무 커요", "입력한 내용을 줄인 뒤 다시 시도해 주세요."],
  429: [
    "잠시 쉬었다 다시 시도해 주세요",
    "짧은 시간에 여러 요청이 들어왔어요. 잠시 후 다시 로그인해 주세요.",
  ],
  500: [
    "잠시 문제가 생겼어요",
    "요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.",
  ],
  503: [
    "지금은 로그인을 사용할 수 없어요",
    "로그인 서비스가 아직 준비되지 않았어요. 잠시 후 다시 방문해 주세요.",
  ],
};

// Only fixed application copy is rendered: never echo URL, OAuth errors, account or tokens.
// retryHref is a server-built value (e.g. "/auth/google?returnTo=...", already validated
// where returnTo originates), never derived from unvalidated request input.
export function errorPage(status: number, retryHref = "/auth/google") {
  const [title, description] = copy[status] || copy[500];
  const login = [400, 401, 403].includes(status);
  return renderPage({
    title: `${title} · 하루의 계획`,
    children: (
      <LoginPage>
        <LoginCard>
          <span className="eyebrow">오류 {status}</span>
          <h1>{title}</h1>
          <p>{description}</p>
          <Actions>
            {login && (
              <a className="primary" href={retryHref}>
                다른 계정으로 로그인 <RightIcon />
              </a>
            )}
            <a className={login ? undefined : "primary"} href="/">
              홈으로 돌아가기
            </a>
          </Actions>
        </LoginCard>
      </LoginPage>
    ),
  });
}
