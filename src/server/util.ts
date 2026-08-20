import crypto from "node:crypto";

export function hash(payload: object) {
  const data = JSON.stringify(payload);
  return crypto.createHash("sha256").update(data).digest("hex");
}
