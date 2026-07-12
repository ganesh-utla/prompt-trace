import * as crypto from "crypto";

/** SHA-256 hex digest of a Buffer/string. */
export function sha256(data: Buffer | string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}
