import { Fragment, type ReactNode } from "react";

export function safeMarkdownLink(value: string) {
  // Only explicit web/mail schemes. No HTML, images, relative URLs or data/javascript URLs.
  if (
    !/^(https?:\/\/|mailto:)/i.test(value) ||
    /[\s\u0000-\u001f\u007f]/.test(value)
  )
    return null;
  try {
    const url = new URL(value);
    return ["http:", "https:", "mailto:"].includes(url.protocol)
      ? url.href
      : null;
  } catch {
    return null;
  }
}
function inline(text: string, depth = 0): ReactNode {
  if (depth > 6) return text;
  const regex =
    /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|\*[^*\n]+\*|\[[^\]\n]+\]\([^\s)]+\))/g;
  const result: ReactNode[] = [];
  let start = 0;
  for (const match of text.matchAll(regex)) {
    const index = match.index!,
      value = match[0];
    result.push(text.slice(start, index));
    let node: ReactNode = value;
    if (value.startsWith("`")) node = <code>{value.slice(1, -1)}</code>;
    else if (value.startsWith("**") || value.startsWith("__"))
      node = <strong>{inline(value.slice(2, -2), depth + 1)}</strong>;
    else if (value.startsWith("~~"))
      node = <del>{inline(value.slice(2, -2), depth + 1)}</del>;
    else if (value.startsWith("*"))
      node = <em>{inline(value.slice(1, -1), depth + 1)}</em>;
    else {
      const link = /^\[([^\]]+)\]\((.+)\)$/.exec(value)!;
      const href = safeMarkdownLink(link[2]);
      node = href ? (
        <a href={href} target="_blank" rel="noopener noreferrer">
          {inline(link[1], depth + 1)}
        </a>
      ) : (
        link[1]
      );
    }
    result.push(<Fragment key={index}>{node}</Fragment>);
    start = index + value.length;
  }
  result.push(text.slice(start));
  return result;
}
export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n"),
    blocks: ReactNode[] = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i],
      key = i;
    if (!line.trim()) {
      i++;
      continue;
    }
    if (/^\s*```/.test(line)) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i]))
        code.push(lines[i++]);
      if (i < lines.length) i++;
      blocks.push(
        <pre key={key}>
          <code>{code.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      const Tag = `h${heading[1].length}` as "h1";
      blocks.push(<Tag key={key}>{inline(heading[2])}</Tag>);
      i++;
      continue;
    }
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      blocks.push(<hr key={key} />);
      i++;
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]))
        quote.push(lines[i++].replace(/^>\s?/, ""));
      blocks.push(
        <blockquote key={key}>{inline(quote.join("\n"))}</blockquote>,
      );
      continue;
    }
    const list = /^\s*(?:([-+*])|\d+\.)\s+/.exec(line);
    if (list) {
      const ordered = !list[1],
        items: ReactNode[] = [],
        pattern = ordered ? /^\s*\d+\.\s+(.*)$/ : /^\s*[-+*]\s+(.*)$/;
      while (i < lines.length) {
        const item = pattern.exec(lines[i]);
        if (!item) break;
        const task = /^\[([ xX])\]\s+(.*)$/.exec(item[1]);
        items.push(
          <li key={i}>
            {task ? (
              <>
                <span aria-label={task[1] === " " ? "미완료" : "완료"}>
                  {task[1] === " " ? "☐" : "☑"}
                </span>{" "}
                {inline(task[2])}
              </>
            ) : (
              inline(item[1])
            )}
          </li>,
        );
        i++;
      }
      const Tag = ordered ? "ol" : "ul";
      blocks.push(<Tag key={key}>{items}</Tag>);
      continue;
    }
    blocks.push(<p key={key}>{inline(line)}</p>);
    i++;
  }
  return <div className="markdown">{blocks}</div>;
}
