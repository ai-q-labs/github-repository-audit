/**
 * One JSON client for the three APIs this Actor reads.
 *
 * All three - GitHub's REST API, the npm registry and PyPI's JSON API - are
 * official, documented and meant to be called by programs, so nothing here
 * scrapes a page. What they need instead is a contact address in the
 * User-Agent (GitHub refuses requests without one), a timeout, and a way to
 * tell a transient failure apart from a spent quota.
 *
 * The quota part matters more than usual. Unauthenticated GitHub calls are
 * capped at 60 an hour **per IP address**, and on Apify that address is shared
 * with every other tenant on the same machine. Retrying a refusal caused by an
 * exhausted quota cannot succeed - the reset is up to an hour away - so it is
 * detected and reported rather than retried.
 */

export const USER_AGENT = 'aiqlabs-github-repository-audit/1.0 (+https://apify.com/aiqlabs)';

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export class HttpError extends Error {
    constructor(status, url, body, headers) {
        super(`HTTP ${status} from ${url}${body ? `: ${String(body).slice(0, 200)}` : ''}`);
        this.name = 'HttpError';
        this.status = status;
        this.url = url;
        this.body = body;
        this.headers = headers ?? null;
    }
}

/** Raised when GitHub's hourly budget is spent. Retrying cannot help; only waiting or a token can. */
export class RateLimitError extends Error {
    constructor(url, resetAt, limit) {
        super(`GitHub rate limit reached (${limit ?? 'unknown'} requests/hour). Resets at ${resetAt ?? 'an unknown time'}.`);
        this.name = 'RateLimitError';
        this.url = url;
        this.resetAt = resetAt;
        this.limit = limit;
    }
}

export function sleep(ms) {
    return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * `Retry-After` is either a delay in seconds or an HTTP date. Both are used in
 * the wild, and guessing wrong on a rate limit means being refused again.
 */
export function retryAfterMs(headers, maxMs = 60000) {
    const raw = headers?.get?.('retry-after');
    if (!raw) return null;
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, maxMs);
    const when = Date.parse(raw);
    if (Number.isNaN(when)) return null;
    return Math.min(Math.max(0, when - Date.now()), maxMs);
}

/**
 * GitHub answers an exhausted quota with 403 (primary limit) or 429 (secondary
 * limit) and sets `x-ratelimit-remaining: 0`. A 403 with quota left is a
 * different animal entirely - a private repository, or a blocked user agent -
 * and must not be reported as a rate limit.
 */
export function readRateLimit(headers) {
    const remaining = headers?.get?.('x-ratelimit-remaining');
    const limit = headers?.get?.('x-ratelimit-limit');
    const reset = headers?.get?.('x-ratelimit-reset');
    const resetAt = reset && Number.isFinite(Number(reset))
        ? new Date(Number(reset) * 1000).toISOString()
        : null;
    return {
        remaining: remaining === null || remaining === undefined ? null : Number(remaining),
        limit: limit === null || limit === undefined ? null : Number(limit),
        resetAt,
    };
}

export function isQuotaExhausted(status, headers) {
    if (status !== 403 && status !== 429) return false;
    const { remaining } = readRateLimit(headers);
    return remaining === 0;
}

/**
 * @param {string} url
 * @param {{timeoutMs?: number, retries?: number, headers?: Record<string,string>,
 *          onRetry?: (info: {attempt: number, waitMs: number, reason: string}) => void,
 *          allowStatuses?: number[]}} [options]
 * @returns {Promise<{status: number, json: any, headers: Headers}>}
 */
export async function fetchJson(url, options = {}) {
    const {
        timeoutMs = 30000,
        retries = 2,
        headers = {},
        onRetry,
        // Statuses that are a legitimate answer rather than a failure. A 404 from
        // GitHub is the whole point of the check for a repository that is gone,
        // so it comes back as data instead of an exception.
        allowStatuses = [],
    } = options;

    let lastError = null;
    let overrideWaitMs = null;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(url, {
                signal: controller.signal,
                headers: {
                    'User-Agent': USER_AGENT,
                    Accept: 'application/json',
                    ...headers,
                },
            });

            // Always read the body, success or not: these APIs explain refusals in it,
            // and leaving a response unread is what puts the HTTP client's parser in
            // the state httpguard.js exists to survive.
            const text = await response.text().catch(() => '');

            // Checked before `allowStatuses`, and deliberately so. A spent allowance
            // is never a legitimate answer: the contributor endpoint treats 403 as
            // "this list is too big to compute", and letting an exhausted quota
            // arrive dressed as that would report the wrong problem to the user.
            if (isQuotaExhausted(response.status, response.headers)) {
                const { resetAt, limit } = readRateLimit(response.headers);
                throw new RateLimitError(url, resetAt, limit);
            }

            if (response.ok || allowStatuses.includes(response.status)) {
                let json = null;
                if (text) {
                    try {
                        json = JSON.parse(text);
                    } catch {
                        json = null;
                    }
                }
                return { status: response.status, json, headers: response.headers };
            }

            const error = new HttpError(response.status, url, text, response.headers);
            if (!RETRYABLE_STATUS.has(response.status) || attempt === retries) throw error;
            lastError = error;
            overrideWaitMs = retryAfterMs(response.headers);
        } catch (err) {
            if (err instanceof RateLimitError) throw err;
            const isAbort = err?.name === 'AbortError';
            const fatal = err instanceof HttpError && !RETRYABLE_STATUS.has(err.status);
            if (fatal || attempt === retries) {
                throw isAbort ? new Error(`Timed out after ${timeoutMs} ms: ${url}`) : err;
            }
            lastError = err;
        } finally {
            clearTimeout(timer);
        }

        const waitMs = overrideWaitMs ?? 800 * (2 ** attempt);
        overrideWaitMs = null;
        onRetry?.({ attempt: attempt + 1, waitMs, reason: String(lastError?.message || lastError).slice(0, 160) });
        await sleep(waitMs);
    }

    throw lastError ?? new Error(`Request failed: ${url}`);
}

/**
 * A manifest is fetched as text, not JSON: `requirements.txt` and `go.mod` are
 * not JSON at all, and a `package.json` served as `text/plain` still has to parse.
 */
export async function fetchText(url, options = {}) {
    const { timeoutMs = 30000, maxBytes = 4 * 1024 * 1024 } = options;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, {
            signal: controller.signal,
            headers: { 'User-Agent': USER_AGENT, Accept: 'text/plain, application/json, */*' },
        });
        const text = await response.text();
        if (!response.ok) throw new HttpError(response.status, url, text, response.headers);
        if (text.length > maxBytes) {
            throw new Error(`Manifest at ${url} is larger than ${maxBytes} bytes.`);
        }
        return text;
    } catch (err) {
        if (err?.name === 'AbortError') throw new Error(`Timed out after ${timeoutMs} ms: ${url}`);
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

/** Fixed-width worker pool, so memory stays flat however long the list is. */
export async function runPool(items, limit, worker) {
    const width = Math.max(1, Math.min(Number(limit) || 1, 20));
    let cursor = 0;
    const results = new Array(items.length).fill(null);
    await Promise.all(
        Array.from({ length: Math.min(width, items.length) }, async () => {
            while (cursor < items.length) {
                const index = cursor;
                cursor += 1;
                try {
                    results[index] = await worker(items[index], index);
                } catch (err) {
                    results[index] = { __error: String(err?.message || err).slice(0, 200) };
                }
            }
        }),
    );
    return results;
}
