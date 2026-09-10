export interface Config {
  origin: string;
  owner: string;
  clientId: string;
  clientSecret: string;
  vapidPublic: string;
  vapidPrivate: string;
  vapidSubject: string;
  demo: boolean;
  production: boolean;
}
export function config(): Config {
  const production = process.env.NODE_ENV === "production";
  const demo = process.env.DEMO_MODE === "1";
  const origin = process.env.APP_ORIGIN || "http://localhost:3000";
  if (
    demo &&
    (production ||
      !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  )
    throw new Error("DEMO_MODE is restricted to local development.");
  if (production && !origin.startsWith("https://"))
    throw new Error("APP_ORIGIN must use HTTPS in production.");
  return {
    origin,
    demo,
    production,
    owner: process.env.OWNER_EMAIL || "crasnec@gmail.com",
    clientId: process.env.GOOGLE_CLIENT_ID || "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
    vapidPublic: process.env.VAPID_PUBLIC_KEY || "",
    vapidPrivate: process.env.VAPID_PRIVATE_KEY || "",
    vapidSubject: process.env.VAPID_SUBJECT || "mailto:crasnec@gmail.com",
  };
}
