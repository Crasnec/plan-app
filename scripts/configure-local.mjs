// Import locally supplied OAuth files without printing credentials or overwriting .env.
import { readFile, writeFile, chmod } from "node:fs/promises";
import webPush from "web-push";
process.umask(0o077);
const clientId = (await readFile("oauth-id.txt", "utf8")).trim();
const clientSecret = (await readFile("oauth-secret.txt", "utf8")).trim();
if (!/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/.test(clientId) || !/^[A-Za-z0-9_-]+$/.test(clientSecret))
  throw new Error("OAuth files must contain only the client ID and secret respectively.");
const keys = webPush.generateVAPIDKeys();
await writeFile(".env", [
  "APP_ORIGIN=https://plan.crasnec.com",
  "OWNER_EMAIL=crasnec@gmail.com",
  `GOOGLE_CLIENT_ID=${clientId}`,
  `GOOGLE_CLIENT_SECRET=${clientSecret}`,
  `VAPID_PUBLIC_KEY=${keys.publicKey}`,
  `VAPID_PRIVATE_KEY=${keys.privateKey}`,
  "VAPID_SUBJECT=mailto:crasnec@gmail.com",
  "DATABASE_PATH=/app/data/plan.sqlite",
  "PORT=3000",
  "CADDY_NETWORK=caddy",
  "",
].join("\n"), { flag: "wx", mode: 0o600 });
await chmod("oauth-id.txt", 0o600);
await chmod("oauth-secret.txt", 0o600);
console.log("Created private .env; OAuth originals restricted to 0600. No credentials printed.");
