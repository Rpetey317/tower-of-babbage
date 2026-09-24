import { createHmac } from "node:crypto";
import { writeFile } from "node:fs/promises";

// Fixed public test data keeps the vector identical across regenerations.
const secret = Buffer.from(
  "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  "hex",
);
const claims = {
  sessionId: "1d953063-05b4-4cac-9249-58c8b1b326a1",
  exp: 1893456000,
};
const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
const signature = createHmac("sha256", secret)
  .update(payload)
  .digest("base64url");
const vector = {
  secret: secret.toString("base64"),
  payload,
  expectedToken: `${payload}.${signature}`,
};

await writeFile(
  new URL("../fixtures/ingest-token.vector.json", import.meta.url),
  `${JSON.stringify(vector, null, 2)}\n`,
);
