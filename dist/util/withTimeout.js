"use strict";
/**
 * src/util/withTimeout.ts — wrap any promise with a hard timeout.
 *
 * The LLM and Google API SDKs can hang with no ceiling, and Express won't abort
 * them for us. A single stuck upstream call would otherwise tie up the request
 * indefinitely. This races the work against a timer that rejects, so a hung
 * dependency fails fast and predictably instead of hanging the user.
 *
 * It does NOT cancel the underlying work (the SDK keeps running in the
 * background); it just stops US from waiting on it. For request-scoped calls
 * that's the right tradeoff — the request returns an error, the orphaned work
 * gets GC'd when its own connection drops.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TimeoutError = void 0;
exports.withTimeout = withTimeout;
class TimeoutError extends Error {
    constructor(label, ms) {
        super(`${label} timed out after ${ms}ms`);
        this.name = "TimeoutError";
    }
}
exports.TimeoutError = TimeoutError;
function withTimeout(work, ms, label = "operation") {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
    });
    return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}
//# sourceMappingURL=withTimeout.js.map