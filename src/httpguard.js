/**
 * Keep one assertion inside Node's HTTP client from ending the run.
 *
 * Node's built-in `fetch` is undici. Its HTTP/1 parser runs
 *
 *     assert(!this.paused)
 *
 * from `Parser.finish`, called out of the socket's `end` handler. When a
 * keep-alive TLS socket closes while that parser is in a paused state, the
 * assertion throws from a timer tick with no JavaScript frame of ours on the
 * stack: no `try`/`catch`, no `.catch()`, and no promise rejection handler can see
 * it, so the process exits and an Actor run is marked failed.
 *
 * What was measured (Node 24.12.0, eight consecutive live runs each):
 *
 *   reader.cancel() on the response stream    crashed 3 of 5
 *   AbortController.abort() instead           crashed 2 of 6
 *   reading every body to completion          crashed 4 of 8
 *
 * So it is not caused by how the bodies are consumed — reading all of them to the
 * end does not stop it. It belongs to the client's socket bookkeeping, which is not
 * reachable from here.
 *
 * The response that the parser belongs to has already been read and returned by the
 * time its socket is torn down, so nothing this Actor produces depends on the
 * failing call. That is the whole reason it is safe to swallow: it is not an error
 * about the work, it is an error about cleaning up after work that finished.
 *
 * Deliberately narrow. The guard matches the assertion text, the error code and the
 * `undici` frame, and anything else keeps the default behaviour of reporting and
 * exiting non-zero — a crash guard that hides real defects would be worse than the
 * crash.
 */

const UNDICI_PAUSED_ASSERTION = /assert\(!this\.paused\)/;

export function isUndiciParserAssertion(err) {
    if (!err || err.code !== 'ERR_ASSERTION') return false;
    if (!UNDICI_PAUSED_ASSERTION.test(String(err.message || ''))) return false;
    return /undici|client-h1/.test(String(err.stack || ''));
}

/**
 * @param {{warning?: (message: string) => void}} [logger]
 * @returns {() => number} how many times the assertion has been swallowed
 */
export function installHttpCrashGuard(logger) {
    let swallowed = 0;

    process.on('uncaughtException', (err) => {
        if (isUndiciParserAssertion(err)) {
            swallowed += 1;
            if (swallowed <= 3) {
                const note = 'Ignored an internal assertion from the HTTP client while a socket was closing '
                    + '(undici Parser.finish, assert(!this.paused)). The response it belongs to had already '
                    + 'been read, so no output is affected.';
                if (logger?.warning) logger.warning(note);
                else console.warn(note);
            }
            return;
        }
        // Not ours to swallow. Reproduce the default: report it and fail.
        console.error(err);
        process.exit(1);
    });

    return () => swallowed;
}
