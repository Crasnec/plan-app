// Browser verification is an optional external test tool, not an app dependency.
// PLAYWRIGHT_MODULE can point to an existing Playwright installation.
import { pathToFileURL } from "node:url";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE
    ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href
    : "playwright"
);
const directory = await mkdtemp(join(tmpdir(), "plan-browser-"));
const origin = "http://localhost:3099";
const server = spawn(process.execPath, ["dist/server/index.js"], {
  env: {
    ...process.env,
    NODE_ENV: "development",
    DEMO_MODE: "1",
    APP_ORIGIN: origin,
    PORT: "3099",
    DATABASE_PATH: join(directory, "demo.sqlite"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
server.stdout.on("data", (x) => (log += x));
server.stderr.on("data", (x) => (log += x));
let browser;
try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${origin}/healthz`)).ok) break;
    } catch {}
    if (i === 99) throw new Error(log);
    await new Promise((r) => setTimeout(r, 100));
  }
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    timezoneId: "America/Los_Angeles",
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(origin);
  await page.getByRole("heading", { name: "오늘도, 차근차근" }).waitFor();
  await page.locator(".task-card").first().waitFor();
  const initialWidth = await page
    .locator(".main-content")
    .evaluate((el) => el.getBoundingClientRect().width);
  await page
    .getByRole("button", { name: "사이드바 숨기기", exact: true })
    .click();
  assert.equal(await page.locator(".sidebar").isVisible(), false);
  assert(
    (await page
      .locator(".main-content")
      .evaluate((el) => el.getBoundingClientRect().width)) > initialWidth,
  );
  await page.reload();
  await page
    .getByRole("button", { name: "사이드바 펼치기", exact: true })
    .waitFor();
  assert.equal(await page.locator(".sidebar").isVisible(), false);
  await page
    .getByRole("button", { name: "사이드바 펼치기", exact: true })
    .click();
  assert.equal(await page.locator(".sidebar").isVisible(), true);
  await page.locator(".task-card").first().waitFor();
  const peer = await context.newPage();
  await peer.goto(origin);
  await peer.locator(".task-card").first().waitFor();
  await mkdir("artifacts", { recursive: true });
  const mcpClientResponse = await page.request.post(`${origin}/register`, {
    data: {
      client_name: "ChatGPT browser test",
      redirect_uris: ["https://chatgpt.com/connector/oauth/browser-test"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
  });
  assert.equal(mcpClientResponse.status(), 201);
  const mcpClient = await mcpClientResponse.json();
  const verifier = randomBytes(32).toString("base64url");
  const authorization = new URLSearchParams({
    client_id: mcpClient.client_id,
    redirect_uri: "https://chatgpt.com/connector/oauth/browser-test",
    response_type: "code",
    scope: "items:read items:write items:delete",
    state: "browser-state",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    resource: `${origin}/mcp`,
  });
  const consent = await context.newPage();
  await consent.setViewportSize({ width: 390, height: 844 });
  await consent.goto(`${origin}/authorize?${authorization}`);
  await consent.getByRole("heading", { name: "ChatGPT 연결 승인" }).waitFor();
  assert.equal(
    await consent
      .getByRole("checkbox", { name: "일정 등록·수정·완료·복구" })
      .isChecked(),
    false,
  );
  assert.equal(
    await consent
      .getByRole("checkbox", { name: "일정 삭제 (휴지통으로 이동)" })
      .isChecked(),
    false,
  );
  assert(
    await consent.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await consent.screenshot({
    path: "artifacts/mobile-mcp-consent.png",
    fullPage: true,
  });
  const consentTicket = new URL(consent.url()).searchParams.get("ticket");
  const consentCsrf = await consent.locator('input[name="csrf"]').inputValue();
  const approved = await page.request.post(`${origin}/mcp/connect`, {
    form: {
      ticket: consentTicket,
      csrf: consentCsrf,
      decision: "approve",
      scope: "items:write",
    },
    headers: { Origin: origin },
    maxRedirects: 0,
  });
  assert.equal(approved.status(), 303);
  await consent.close();
  await page.screenshot({
    path: "artifacts/desktop-month.png",
    fullPage: true,
  });
  const openSettings = async (name) => {
    assert.equal(
      await page.getByRole("button", { name: "설정", exact: true }).count(),
      1,
    );
    await page.getByRole("button", { name: "설정", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name, exact: true })
      .click();
  };
  await openSettings("세션 관리");
  await page.getByText("로컬 데모에는 로그인 세션이 없습니다.").waitFor();
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  let browserSessions = [
    {
      id: "this-browser",
      device: "Android · Chrome",
      current: true,
      createdAt: "2026-09-14T00:00:00.000Z",
      lastSeenAt: "2026-09-14T00:00:00.000Z",
      expiresAt: "2026-10-14T00:00:00.000Z",
    },
    {
      id: "other-browser",
      device: "Windows · Edge",
      current: false,
      createdAt: null,
      lastSeenAt: null,
      expiresAt: "2026-10-14T00:00:00.000Z",
    },
  ];
  await page.route("**/api/sessions", (route) =>
    route.fulfill({ json: { sessions: browserSessions, demo: false } }),
  );
  await page.route("**/api/sessions/other-browser/revoke", (route) => {
    assert.equal(route.request().method(), "POST");
    browserSessions = browserSessions.filter((s) => s.current);
    return route.fulfill({ json: { current: false } });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await openSettings("세션 관리");
  await page.locator(".current-session").waitFor();
  assert.equal(await page.getByText("이 기기", { exact: true }).count(), 1);
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.screenshot({
    path: "artifacts/mobile-sessions.png",
    fullPage: false,
  });
  await page
    .getByRole("button", { name: "이 기기 로그아웃", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "이 기기를 로그아웃할까요?" })
    .waitFor();
  await page
    .locator(".session-confirm")
    .getByRole("button", { name: "취소", exact: true })
    .click();
  await page
    .locator(".session-card")
    .filter({ hasText: "Windows · Edge" })
    .getByRole("button", { name: "로그아웃", exact: true })
    .click();
  await page.getByRole("button", { name: "로그아웃하기", exact: true }).click();
  await page.getByText("선택한 세션을 로그아웃했습니다.").waitFor();
  assert.equal(await page.locator(".session-card").count(), 1);
  assert.equal(
    await page
      .getByRole("button", { name: "다른 기기 모두 로그아웃" })
      .isDisabled(),
    true,
  );
  await page.getByRole("button", { name: "기본 설정", exact: true }).click();
  await page.getByRole("heading", { name: "설정", exact: true }).waitFor();
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  await page.unroute("**/api/sessions");
  await page.unroute("**/api/sessions/other-browser/revoke");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page
    .locator(".sidebar-bottom")
    .getByRole("button", { name: "설정", exact: true })
    .click();
  await page.getByRole("heading", { name: "기본 설정", exact: true }).waitFor();
  await page.getByLabel("기본 소요 시간 (분)").fill("90");
  await page.getByRole("button", { name: "MCP 연결", exact: true }).click();
  await page.getByText(/유효기한 없음 · 연결:/).waitFor();
  await page.getByRole("button", { name: "연결 폐기", exact: true }).click();
  await page.getByRole("button", { name: "폐기하기", exact: true }).click();
  await page
    .getByRole("heading", { name: "MCP · ChatGPT · 폐기됨", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "기본 설정", exact: true }).click();
  assert.equal(await page.getByLabel("기본 소요 시간 (분)").inputValue(), "90");
  await page
    .locator(".settings-footer-actions")
    .getByRole("button", { name: "취소", exact: true })
    .click();
  await page.getByRole("button", { name: "설정", exact: true }).click();
  assert.equal(await page.getByLabel("기본 소요 시간 (분)").inputValue(), "60");
  assert.equal(
    await page.getByRole("button", { name: "적용", exact: true }).isDisabled(),
    true,
  );
  await page.getByLabel("기본 소요 시간 (분)").fill("45");
  await page.getByLabel("완료 일정", { exact: true }).selectOption("false");
  await page.getByLabel("새 일정의 공유 공개 기본값").selectOption("true");
  await page.getByLabel("API 새 일정에도 기본값 적용").selectOption("true");
  await page.getByRole("button", { name: "적용", exact: true }).click();
  await page.getByText("기본 설정을 저장했습니다.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  await page.reload();
  await page.getByRole("button", { name: "새 할 일", exact: true }).waitFor();
  await page.waitForFunction(
    () =>
      !document
        .querySelector(".filter-tabs button:last-child")
        ?.textContent.includes("완료"),
  );
  assert.equal(await page.locator(".task-card.done").count(), 0);
  await peer.waitForFunction(
    () =>
      document.querySelector(".filter-tabs") &&
      !document
        .querySelector(".filter-tabs button:last-child")
        ?.textContent.includes("완료"),
  );
  await page.getByRole("button", { name: "새 할 일", exact: true }).click();
  assert.equal(await page.getByLabel("공유 링크에 공개").isChecked(), true);
  await page.getByLabel("일정 유형").selectOption("timed");
  assert(
    (await page.getByLabel("시작", { exact: true }).inputValue()).endsWith(
      "T09:00",
    ),
  );
  assert(
    (await page.getByLabel("종료", { exact: true }).inputValue()).endsWith(
      "T09:45",
    ),
  );
  const newStart =
    (await page.getByLabel("시작", { exact: true }).inputValue()).slice(0, 10) +
    "T13:00";
  await page.getByLabel("시작", { exact: true }).fill(newStart);
  assert(
    (await page.getByLabel("종료", { exact: true }).inputValue()).endsWith(
      "T13:45",
    ),
  );
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  await page.getByRole("button", { name: "설정", exact: true }).click();
  assert.equal(await page.getByLabel("기본 소요 시간 (분)").inputValue(), "45");
  await page.getByLabel("기본 소요 시간 (분)").fill("60");
  await page.getByLabel("완료 일정", { exact: true }).selectOption("true");
  await page.getByLabel("새 일정의 공유 공개 기본값").selectOption("false");
  await page.getByLabel("API 새 일정에도 기본값 적용").selectOption("false");
  await page.getByRole("button", { name: "확인", exact: true }).click();
  await page.getByText("기본 설정을 저장했습니다.", { exact: true }).waitFor();
  assert.equal(await page.getByRole("dialog").count(), 0);
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "알림 설정", exact: true })
    .click();
  await page.getByRole("button", { name: "기본 설정", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "API 키 관리", exact: true })
    .click();
  await page.getByLabel("키 이름", { exact: true }).fill("브라우저 테스트 키");
  await page.getByRole("button", { name: "API 키 발급", exact: true }).click();
  const apiKey = await page
    .getByLabel("발급된 API 키", { exact: true })
    .inputValue();
  assert.match(apiKey, /^plan_agent_/);
  await page.getByRole("button", { name: "기본 설정", exact: true }).click();
  await page.getByRole("alert").waitFor();
  assert.equal(
    await page.getByLabel("발급된 API 키", { exact: true }).count(),
    1,
  );
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  await page.getByRole("alert").waitFor();
  await page.getByLabel("안전하게 저장했습니다").check();
  await page.getByRole("button", { name: "키 보관 완료", exact: true }).click();
  assert.equal(
    await page.getByLabel("발급된 API 키", { exact: true }).count(),
    0,
  );
  const authorized = await page.request.get(`${origin}/api/agent/v1/me`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  assert.equal(authorized.status(), 200);
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.getByRole("button", { name: "설정", exact: true }).count(),
    1,
  );
  await page.getByRole("button", { name: "설정", exact: true }).click();
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.screenshot({
    path: "artifacts/mobile-settings.png",
    fullPage: false,
  });
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "API 키 관리", exact: true })
    .click();
  await page
    .getByRole("button", { name: "브라우저 테스트 키 키 폐기", exact: true })
    .click();
  await page.getByRole("button", { name: "폐기하기", exact: true }).click();
  await page.getByText("폐기됨", { exact: true }).waitFor();
  assert.equal(
    (
      await page.request.get(`${origin}/api/agent/v1/me`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      })
    ).status(),
    401,
  );
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "새 할 일", exact: true }).click();
  await page.getByLabel("제목", { exact: true }).fill("브라우저 확인 일정");
  await page
    .getByLabel("메모", { exact: true })
    .fill("공유 화면에서도 읽을 수 있는 메모");
  await page.getByLabel("공유 링크에 공개", { exact: false }).check();
  await page.getByRole("button", { name: "저장하기", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page
    .locator(".task-card")
    .filter({ hasText: "브라우저 확인 일정" })
    .waitFor();
  await peer
    .locator(".task-card")
    .filter({ hasText: "브라우저 확인 일정" })
    .waitFor();
  assert.equal(await page.locator(".history-toolbar").count(), 0);
  await page
    .locator(".toast")
    .getByRole("button", { name: "실행 취소", exact: true })
    .click();
  await page
    .locator(".task-card")
    .filter({ hasText: "브라우저 확인 일정" })
    .waitFor({ state: "hidden" });
  await peer
    .locator(".task-card")
    .filter({ hasText: "브라우저 확인 일정" })
    .waitFor({ state: "hidden" });
  await page.waitForFunction(() =>
    [...document.querySelectorAll("button")].some(
      (b) => b.textContent === "다시 실행" && !b.disabled,
    ),
  );
  await page
    .locator(".toast")
    .getByRole("button", { name: "다시 실행", exact: true })
    .click();
  await page
    .locator(".task-card")
    .filter({ hasText: "브라우저 확인 일정" })
    .waitFor();
  await peer
    .locator(".task-card")
    .filter({ hasText: "브라우저 확인 일정" })
    .waitFor();
  await page.getByRole("button", { name: "알림 닫기", exact: true }).click();
  assert.equal(await page.locator(".toast").count(), 0);
  await page.keyboard.press("Control+z");
  await page
    .locator(".task-card")
    .filter({ hasText: "브라우저 확인 일정" })
    .waitFor({ state: "hidden" });
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".toast button")].some(
      (b) => b.textContent === "다시 실행" && !b.disabled,
    ),
  );
  await page.keyboard.press("Control+Shift+z");
  await page
    .locator(".task-card")
    .filter({ hasText: "브라우저 확인 일정" })
    .waitFor();
  await peer.close();
  const koreanToday = new Date(Date.now() + 9 * 3600000)
    .toISOString()
    .slice(0, 10);
  const tomorrow = new Date(Date.parse(`${koreanToday}T00:00:00Z`) + 86400000)
    .toISOString()
    .slice(0, 10);
  const source = () =>
    page
      .locator(".calendar-event")
      .filter({ hasText: "브라우저 확인 일정" })
      .first();
  const target = (d) =>
    page.locator(".day-cell").filter({
      has: page.getByRole("button", { name: `${d} 선택`, exact: true }),
    });
  let changes = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/api\/items\/[^/]+\/change$/.test(new URL(request.url()).pathname)
    )
      changes++;
  });
  await source().dragTo(target(koreanToday));
  assert.equal(
    changes,
    0,
    "Dropping on the same date must not send a change request",
  );
  await source().getByRole("button").click();
  await page.getByRole("button", { name: "저장하기", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(
    changes,
    0,
    "Saving unchanged fields must not send a change request",
  );
  const grab = await source().getByRole("button").boundingBox();
  const destination = await target(tomorrow).boundingBox();
  assert(grab && destination);
  await page.mouse.move(grab.x + grab.width / 2, grab.y + grab.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    grab.x + grab.width / 2 + 12,
    grab.y + grab.height / 2,
    { steps: 5 },
  );
  await page.mouse.move(
    destination.x + destination.width / 2,
    destination.y + destination.height / 2,
    { steps: 12 },
  );
  await page.mouse.move(
    destination.x + destination.width / 2 + 1,
    destination.y + destination.height / 2,
  );
  await target(tomorrow).locator(".drop-label").waitFor();
  assert.match(await target(tomorrow).getAttribute("class"), /drop-target/);
  await page.screenshot({
    path: "artifacts/drag-destination.png",
    fullPage: true,
  });
  await page.mouse.up();
  assert.equal(await page.locator(".drop-target").count(), 0);
  await page
    .locator(".task-card")
    .filter({ hasText: "브라우저 확인 일정" })
    .waitFor({ state: "hidden" });
  assert.equal(changes, 1, "A real move must still send one change request");
  await source().dragTo(target(koreanToday));
  await page
    .locator(".task-card")
    .filter({ hasText: "브라우저 확인 일정" })
    .waitFor();
  await source().locator(".resize-handle").dragTo(target(tomorrow));
  await page.waitForFunction(
    async ({ from, to }) => {
      const events = await (
        await fetch(`/api/items?from=${from}&to=${to}`)
      ).json();
      return events.find((e) => e.title === "브라우저 확인 일정")?.end > to;
    },
    { from: koreanToday, to: tomorrow },
  );
  await page
    .getByRole("checkbox", { name: "브라우저 확인 일정 완료 표시" })
    .click();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[aria-label="브라우저 확인 일정 완료 표시"]')
        ?.getAttribute("aria-checked") === "true",
  );
  await page
    .locator(".task-card")
    .filter({ hasText: "브라우저 확인 일정" })
    .locator(".task-content")
    .click();
  await page.getByRole("button", { name: "삭제", exact: true }).click();
  await page.getByRole("button", { name: "삭제하기", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page
    .locator(".sidebar-bottom")
    .getByRole("button", { name: "휴지통", exact: true })
    .click();
  await page.getByRole("button", { name: "복구", exact: true }).click();
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  await page
    .locator(".task-card")
    .filter({ hasText: "브라우저 확인 일정" })
    .waitFor();
  await page
    .locator(".view-switch")
    .getByRole("button", { name: "주", exact: true })
    .click();
  await page.locator(".time-event").first().waitFor();
  assert.equal(await page.locator(".time-event").count(), 2);
  assert.equal(
    await page
      .locator(".time-event")
      .first()
      .evaluate((e) => e.style.width),
    "50%",
  );
  await page.screenshot({ path: "artifacts/desktop-week.png", fullPage: true });
  const dragTime = async (delta, expected) => {
    const block = page
      .locator(".time-event")
      .filter({ hasText: "집중해서 프로젝트 정리" })
      .first();
    const box = await block.getByRole("button").boundingBox();
    assert(box);
    const before = changes;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 10, box.y + box.height / 2, {
      steps: 5,
    });
    await page.mouse.move(
      box.x + box.width / 2,
      box.y + box.height / 2 + delta,
      { steps: 12 },
    );
    await page.mouse.move(
      box.x + box.width / 2 + 1,
      box.y + box.height / 2 + delta,
    );
    await page.locator(".time-drop-preview").waitFor();
    assert.match(
      await page.locator(".time-drop-preview").textContent(),
      new RegExp(expected),
    );
    await page.mouse.up();
    await page.waitForFunction(
      ({ expected }) =>
        [...document.querySelectorAll(".time-event button")].some(
          (e) =>
            e.textContent.includes("집중해서 프로젝트 정리") &&
            e.textContent.includes(expected),
        ),
      { expected },
    );
    assert.equal(changes, before + (delta ? 1 : 0));
    assert.equal(await page.locator(".time-drop-preview").count(), 0);
  };
  await dragTime(0, "10:00");
  await dragTime(60, "11:00");
  await page
    .locator(".view-switch")
    .getByRole("button", { name: "일", exact: true })
    .click();
  assert.equal(await page.locator(".time-column").count(), 1);
  await dragTime(-60, "10:00");
  const convertingTitle = "브라우저 확인 일정";
  const allDayEvent = () =>
    page
      .locator(".all-day-row .calendar-event")
      .filter({ hasText: convertingTitle })
      .first();
  const timedEvent = () =>
    page.locator(".time-event").filter({ hasText: convertingTitle }).first();
  const conversionsBefore = changes;
  await allDayEvent()
    .getByRole("button")
    .dragTo(page.locator(".time-column .time-slot").nth(26), {
      targetPosition: { x: 20, y: 2 },
    });
  await timedEvent().waitFor();
  await page.waitForFunction(
    async ({ from, to, title }) => {
      const items = await (
        await fetch(`/api/items?from=${from}&to=${to}`)
      ).json();
      const item = items.find((e) => e.title === title);
      return (
        item?.kind === "timed" &&
        Date.parse(item.end) - Date.parse(item.start) === 3600000 &&
        item.reminder === 10
      );
    },
    { from: koreanToday, to: tomorrow, title: convertingTitle },
  );
  assert.equal(changes, conversionsBefore + 1);
  await timedEvent()
    .getByRole("button")
    .dragTo(page.locator(".all-day-row > div"), {
      targetPosition: { x: 20, y: 5 },
    });
  await allDayEvent().waitFor();
  assert.equal(await timedEvent().count(), 0);
  assert.equal(changes, conversionsBefore + 2);
  await page
    .locator(".view-switch")
    .getByRole("button", { name: "주", exact: true })
    .click();
  await openSettings("공유 링크");
  await page
    .getByRole("button", { name: "공유 링크 만들기", exact: true })
    .click();
  const link = await page
    .locator(".settings-content input[readonly]")
    .inputValue();
  const visitor = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  await visitor.goto(link);
  await visitor.locator(".task-card").first().waitFor();
  assert.equal(
    await visitor
      .getByRole("button", { name: "새 할 일", exact: true })
      .count(),
    0,
  );
  assert.equal(
    await visitor.getByText("책 읽는 시간", { exact: true }).count(),
    0,
  );
  assert.equal(
    await visitor.getByText("가벼운 아침 산책", { exact: true }).count(),
    0,
  );
  await visitor.screenshot({ path: "artifacts/shared.png", fullPage: true });
  await page.getByRole("button", { name: "비활성화", exact: true }).click();
  await visitor.reload();
  await visitor.getByRole("alert").waitFor();
  assert.equal(await visitor.locator(".task-card").count(), 0);
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .locator(".view-switch")
    .getByRole("button", { name: "월", exact: true })
    .click();
  await page.screenshot({ path: "artifacts/mobile-month.png", fullPage: true });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "Mobile page must not overflow horizontally",
  );
  await page.getByRole("button", { name: "새 할 일", exact: true }).click();
  await page.getByLabel("제목", { exact: true }).fill("매월 마지막 월요일");
  await page.getByLabel("반복", { exact: true }).selectOption("monthly");
  await page
    .getByLabel("월별 기준", { exact: true })
    .selectOption("nth_weekday");
  await page.getByLabel("순서", { exact: true }).selectOption("-1");
  await page.getByLabel("요일", { exact: true }).selectOption("0");
  await page.screenshot({
    path: "artifacts/mobile-editor.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "저장하기", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "새 할 일", exact: true }).click();
  const longTitle = "W".repeat(200);
  await page.getByLabel("제목", { exact: true }).fill(longTitle);
  await page
    .getByLabel("메모", { exact: true })
    .fill(
      "# 메모 제목\n**강조된 내용**\n- [x] 완료\n[참고](https://example.com)\n```\n" +
        "x".repeat(1000) +
        "\n```\n<img src=x onerror=alert(1)>",
    );
  await page
    .locator(".markdown-preview")
    .getByRole("heading", { name: "메모 제목" })
    .waitFor();
  await page.getByRole("button", { name: "저장하기", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  const longCard = page.locator(".task-card").filter({ hasText: longTitle });
  await longCard.getByRole("heading", { name: "메모 제목" }).waitFor();
  assert.equal(await longCard.locator("img").count(), 0);
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      "Long content must not widen page",
    );
    assert(
      await longCard.evaluate((el) => {
        const card = el.getBoundingClientRect();
        const content = el.querySelector(".task-body").getBoundingClientRect();
        return content.right <= card.right && content.left >= card.left;
      }),
      "Long content must stay inside card",
    );
  }
  const crowdedDay = target(koreanToday);
  const more = crowdedDay.getByRole("button", { name: /개 더 보기/ });
  await more.waitFor();
  assert.equal(await crowdedDay.locator(".calendar-event").count(), 3);
  await more.click();
  assert((await crowdedDay.locator(".calendar-event").count()) > 3);
  assert.equal(
    await crowdedDay
      .getByRole("button", { name: "접기", exact: true })
      .getAttribute("aria-expanded"),
    "true",
  );
  await crowdedDay.locator(".calendar-event button").last().click();
  await page.getByRole("dialog").waitFor();
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  await crowdedDay.getByRole("button", { name: "접기", exact: true }).click();
  assert.equal(await crowdedDay.locator(".calendar-event").count(), 3);
  await more.click();
  assert((await crowdedDay.locator(".calendar-event").count()) > 3);
  await page.getByRole("button", { name: "다음 기간", exact: true }).click();
  await page.getByRole("button", { name: "이전 기간", exact: true }).click();
  await crowdedDay.locator(".calendar-event").first().waitFor();
  assert.equal(await crowdedDay.locator(".calendar-event").count(), 3);
  assert.deepEqual(errors, []);
  console.log(
    "Browser smoke passed: desktop/mobile, create/complete/delete/restore, drag/resize, cross-tab sync, day/week/month, shared privacy/revocation, overlap layout, monthly last weekday, non-Korean browser timezone.",
  );
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  await new Promise((r) => server.once("exit", r));
  await rm(directory, { recursive: true, force: true });
}
