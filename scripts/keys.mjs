import webPush from "web-push";
const keys = webPush.generateVAPIDKeys();
console.log(
  `VAPID_PUBLIC_KEY=${keys.publicKey}\nVAPID_PRIVATE_KEY=${keys.privateKey}`,
);
console.error(
  "Save these once in your private .env. Do not commit or rotate them without re-subscribing devices.",
);
