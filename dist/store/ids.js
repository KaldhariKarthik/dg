"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.newSessionId = newSessionId;
/**
 * src/store/ids.ts — id generation shared by store implementors.
 */
const crypto_1 = require("crypto");
/** 256 bits of entropy, URL-safe. Because sessions are validated server-side,
 *  a forged id simply fails to resolve — this opaque random IS the boundary. */
function newSessionId() {
    return (0, crypto_1.randomBytes)(32).toString("base64url");
}
//# sourceMappingURL=ids.js.map