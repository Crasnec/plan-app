// Capture only an isolated local demo. Never opens the production site or reads .env.
import { pathToFileURL } from "node:url";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright");
const directory = await mkdtemp(join(tmpdir(), "plan-screenshots-"));
const origin = "http://localhost:3098";
const server = spawn(process.execPath, ["dist/server/index.js"], {
  env: { PATH: process.env.PATH, NODE_ENV: "development", DEMO_MODE: "1",
    APP_ORIGIN: origin, PORT: "3098", DATABASE_PATH: join(directory, "demo.sqlite") },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
server.stdout.on("data", x => log += x);
server.stderr.on("data", x => log += x);
const exited = new Promise(resolve => server.once("exit", resolve));
let browser;
try {
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error(log);
    try { if ((await fetch(`${origin}/healthz`)).ok) break; } catch {}
    if (i === 99) throw new Error("Demo startup timed out: " + log);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, timezoneId: "Asia/Seoul", deviceScaleFactor: 1 });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(origin);
  await page.locator(".task-card").first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  await mkdir("docs/screenshots", { recursive: true });
  const capture = name => page.screenshot({ path: `docs/screenshots/${name}.png`, fullPage: true, animations: "disabled" });
  await capture("desktop-month");
  await page.locator(".view-switch").getByRole("button", { name: "주", exact: true }).click();
  await page.locator(".time-event").first().waitFor();
  await capture("desktop-week");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".view-switch").getByRole("button", { name: "월", exact: true }).click();
  await capture("mobile-month");
  await page.getByRole("button", { name: "새 할 일", exact: true }).click();
  await page.getByLabel("제목", { exact: true }).fill("한 달을 돌아보는 시간");
  await page.getByLabel("반복", { exact: true }).selectOption("monthly");
  await page.getByLabel("월별 기준", { exact: true }).selectOption("nth_weekday");
  await page.getByLabel("순서", { exact: true }).selectOption("-1");
  await page.getByLabel("요일", { exact: true }).selectOption("0");
  await page.getByRole("button", { name: "저장하기", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: "docs/screenshots/mobile-editor.png", fullPage: false, animations: "disabled" });
  if (errors.length) throw new Error(errors.join("\n"));
  console.log("Captured four demo screenshots in docs/screenshots; no production data used.");
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  await exited;
  await rm(directory, { recursive: true, force: true });
}
