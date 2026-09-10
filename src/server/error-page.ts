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
export function errorPage(status: number) {
  const [title, description] = copy[status] || copy[500];
  const login = [400, 401, 403].includes(status);
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#f8f6f0"><meta name="robots" content="noindex,nofollow">
<title>${title} · 하루의 계획</title>
<style>
*{box-sizing:border-box}body{margin:0;min-height:100svh;background:#f8f6f0;color:#344033;font-family:system-ui,-apple-system,"Noto Sans KR",sans-serif;display:grid;place-items:center;padding:24px}
main{width:min(100%,560px)}.brand{font-size:15px;color:#65765d;margin:0 0 28px;letter-spacing:.05em}.card{padding:44px;border:1px solid #e4e7da;border-radius:24px;background:#fffefa;box-shadow:0 12px 40px #34403305}.mark{display:grid;place-items:center;width:56px;height:56px;background:#e8eddc;border-radius:18px;color:#758d66;font-size:26px}.code{font-size:12px;letter-spacing:.16em;color:#73836a;margin-top:28px}h1{font-size:27px;line-height:1.4;word-break:keep-all;margin:12px 0 18px}p{line-height:1.85;word-break:keep-all;color:#687260}.actions{display:flex;flex-wrap:wrap;gap:12px;margin-top:30px}a{display:inline-block;text-decoration:none;color:#fff;background:#728a65;border-radius:12px;padding:13px 18px;font-size:14px;font-weight:600}.secondary{background:#eef0e6;color:#46553d}a:focus-visible{outline:3px solid #344033;outline-offset:4px}footer{font-size:12px;color:#7d8873;margin-top:24px;text-align:center}@media(max-width:480px){.card{padding:28px}h1{font-size:24px}.actions{flex-direction:column}a{text-align:center}}
</style></head><body><main><div class="brand">하루의 계획</div><section class="card" aria-labelledby="title"><div class="mark" aria-hidden="true">☘</div><div class="code">${status}</div><h1 id="title">${title}</h1><p>${description}</p><nav class="actions" aria-label="다음 단계">${login ? '<a href="/auth/google">다른 계정으로 로그인</a>' : ""}<a href="/"${login ? ' class="secondary"' : ""}>홈으로 돌아가기</a></nav></section><footer>나만의 속도로, 차근차근.</footer></main></body></html>`;
}
