/**
 * src/store/ids.ts — id generation shared by store implementors.
 */
import { randomBytes } from "crypto";

/** 256 bits of entropy, URL-safe. Because sessions are validated server-side,
 *  a forged id simply fails to resolve — this opaque random IS the boundary. */
export function newSessionId(): string {
    return randomBytes(32).toString("base64url");
}