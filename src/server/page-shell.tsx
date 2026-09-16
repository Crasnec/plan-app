// Shared chrome for the small server-rendered pages that run outside the React
// app (pre-login prompts, OAuth consent, error pages). Real JSX instead of
// hand-built HTML strings gets us tag matching, typechecked props and
// automatic escaping of every interpolated value; loading the app's own
// stylesheet keeps them visually identical to the real login page instead of
// drifting into a second, hand-copied palette.
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

function Svg({ path, size }: { path: string; size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  );
}
export const LeafIcon = ({ size = 20 }: { size?: number }) => (
  <Svg path="M19 4C8 2 2 9 7 16s15-2 12-12ZM7 17l8-9" size={size} />
);
export const RightIcon = ({ size = 20 }: { size?: number }) => (
  <Svg path="m10 6 6 6-6 6" size={size} />
);
export const LockIcon = ({ size = 20 }: { size?: number }) => (
  <Svg path="M6 10h12v10H6zM8 10V7a4 4 0 0 1 8 0v3" size={size} />
);

export function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark">
        <LeafIcon size={28} />
      </span>
      하루의 계획
    </div>
  );
}
export function LoginPage({ children }: { children: ReactNode }) {
  return (
    <main className="login-page">
      <Brand />
      {children}
      <footer>작은 계획이 모여, 나다운 하루.</footer>
    </main>
  );
}
export function LoginCard({ children }: { children: ReactNode }) {
  return <div className="login-card">{children}</div>;
}
export function Actions({ children }: { children: ReactNode }) {
  return <div className="settings-actions">{children}</div>;
}

// refresh, when given, is a server-built URL (already validated where it
// originates), never raw request input; React still escapes it like any
// other attribute value.
export function renderPage(opts: {
  title: string;
  refresh?: string;
  children: ReactNode;
}) {
  const html = renderToStaticMarkup(
    <html lang="ko">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <meta name="theme-color" content="#f8f6f0" />
        <meta name="robots" content="noindex,nofollow" />
        {opts.refresh && (
          <meta httpEquiv="refresh" content={`0;url=${opts.refresh}`} />
        )}
        <link rel="icon" href="/icon.svg" type="image/svg+xml" />
        <link rel="stylesheet" href="/app.css" />
        <title>{opts.title}</title>
      </head>
      <body>{opts.children}</body>
    </html>,
  );
  return `<!doctype html>${html}`;
}
