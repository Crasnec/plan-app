import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown, safeMarkdownLink } from "../src/web/Markdown.js";
test("Markdown renders basic blocks and inline styles without interpreting HTML", () => {
  const html = renderToStaticMarkup(
    <Markdown
      text={
        "# 제목\n**강조** *기울임* ~~취소~~ `코드`\n- [x] 완료\n- 항목\n1. 순서\n> 인용\n```js\n<script>alert(1)</script>\n```\n[링크](https://example.com)\n<img src=x onerror=alert(1)>\n- \n"
      }
    />,
  );
  for (const tag of [
    "h1",
    "strong",
    "em",
    "del",
    "code",
    "ul",
    "ol",
    "blockquote",
    "pre",
  ])
    assert.match(html, new RegExp(`<${tag}[ >]`));
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script|<img/);
  assert.match(html, /rel="noopener noreferrer"/);
});
test("Markdown links reject executable protocols and control characters", () => {
  for (const value of [
    "javascript:alert(1)",
    "data:text/html,test",
    "//example.com",
    "https://example.com\n",
    "java\tscript:foo",
  ])
    assert.equal(safeMarkdownLink(value), null);
  assert.equal(safeMarkdownLink("https://example.com"), "https://example.com/");
  assert.match(
    renderToStaticMarkup(<Markdown text="[unsafe](javascript:evil)" />),
    /unsafe/,
  );
  assert.doesNotMatch(
    renderToStaticMarkup(<Markdown text="[unsafe](javascript:evil)" />),
    /href/,
  );
});
