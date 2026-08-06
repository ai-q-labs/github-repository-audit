/**
 * What GitHub says about a repository right now.
 *
 * One request per repository carries almost everything worth knowing:
 * `full_name` (which quietly changes when a project is renamed or handed to a
 * different organisation), `archived`, `pushed_at`, `license.spdx_id`, `fork`
 * and `parent`. That single-request budget is deliberate - unauthenticated
 * callers get 60 requests an hour per IP, and on shared infrastructure that
 * allowance is shared with strangers.
 *
 * The deeper checks (contributors, releases) each cost another request per
 * repository, so they are off unless asked for.
 */

import { fetchJson } from './http.js';
import { sameRepo } from './parse.js';

const API = 'https://api.github.com';

export function githubHeaders(token) {
    const headers = {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
}

export function daysBetween(iso, now = Date.now()) {
    const t = Date.parse(iso ?? '');
    if (Number.isNaN(t)) return null;
    return Math.floor((now - t) / 86400000);
}

/**
 * @param {{owner: string, name: string, full: string}} ref
 * @returns {Promise<object>} a flat record; `exists: false` is an answer, not an error
 */
export async function fetchRepo(ref, options = {}) {
    const { token, timeoutMs = 30000, now = Date.now() } = options;
    const url = `${API}/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.name)}`;
    const { status, json } = await fetchJson(url, {
        timeoutMs,
        headers: githubHeaders(token),
        allowStatuses: [404],
        retries: 1,
    });

    if (status === 404 || !json?.full_name) {
        return {
            requestedRepo: ref.full,
            exists: false,
            httpStatus: status,
            // Without a token GitHub answers 404 for a private repository as well as a
            // deleted one, so the two cannot be told apart and must not be conflated.
            notFoundReason: token ? 'no such repository, or no access with this token' : 'deleted, renamed away, or private',
            resolvedRepo: null,
            moved: null,
        };
    }

    const resolved = json.full_name;
    const moved = !sameRepo(resolved, ref.full);
    const license = json.license ?? null;
    const spdx = license?.spdx_id && license.spdx_id !== 'NOASSERTION' ? license.spdx_id : null;

    return {
        requestedRepo: ref.full,
        exists: true,
        httpStatus: status,
        resolvedRepo: resolved,
        moved,
        moveKind: moved
            ? (String(resolved).split('/')[0].toLowerCase() === ref.owner.toLowerCase() ? 'renamed' : 'transferred')
            : null,
        archived: json.archived === true,
        disabled: json.disabled === true,
        isFork: json.fork === true,
        parentRepo: json.parent?.full_name ?? null,
        parentPushedAt: json.parent?.pushed_at ?? null,
        isTemplate: json.is_template === true,
        defaultBranch: json.default_branch ?? null,
        createdAt: json.created_at ?? null,
        pushedAt: json.pushed_at ?? null,
        updatedAt: json.updated_at ?? null,
        daysSinceLastPush: daysBetween(json.pushed_at, now),
        stars: json.stargazers_count ?? null,
        forks: json.forks_count ?? null,
        watchers: json.subscribers_count ?? null,
        openIssues: json.open_issues_count ?? null,
        hasIssuesEnabled: json.has_issues === true,
        topics: Array.isArray(json.topics) ? json.topics.slice(0, 20) : [],
        description: json.description ? String(json.description).slice(0, 300) : null,
        homepage: json.homepage || null,
        // `spdx_id: "NOASSERTION"` means GitHub found a LICENSE file it could not
        // match to a standard licence. That is exactly what a relicensing to BUSL,
        // SSPL or the Elastic Licence looks like from the outside, so it is kept as
        // a distinct signal rather than folded into "no licence".
        repoLicenseSpdx: spdx,
        repoLicenseName: license?.name ?? null,
        repoLicenseNonStandard: Boolean(license) && !spdx,
        repoHasNoLicenseFile: !license,
        htmlUrl: json.html_url ?? null,
    };
}

/**
 * Contributor concentration, sometimes called the bus factor. GitHub returns
 * contributors ordered by commit count; the shape of that list says more about
 * a project's fragility than its star count does.
 */
export async function fetchBusFactor(fullName, options = {}) {
    const { token, timeoutMs = 30000 } = options;
    const [owner, name] = String(fullName).split('/');
    const url = `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contributors?per_page=100&anon=0`;
    const { status, json } = await fetchJson(url, {
        timeoutMs,
        headers: githubHeaders(token),
        allowStatuses: [204, 403, 404],
        retries: 1,
    });
    // 204 means an empty repository; 403 here means the contributor list is too
    // large for GitHub to compute, which it reports for a handful of huge projects.
    if (status !== 200 || !Array.isArray(json) || json.length === 0) {
        return { contributorCount: null, topContributorShare: null, topContributor: null, contributorsNote: `contributor list unavailable (HTTP ${status})` };
    }
    const counts = json.map((c) => Number(c.contributions) || 0);
    const total = counts.reduce((a, b) => a + b, 0);
    return {
        contributorCount: json.length >= 100 ? 100 : json.length,
        contributorCountIsCapped: json.length >= 100,
        topContributor: json[0]?.login ?? null,
        topContributorShare: total > 0 ? Number((counts[0] / total).toFixed(3)) : null,
        contributorsNote: null,
    };
}

/** The date of the last tagged release, which can be years behind the last commit. */
export async function fetchLatestRelease(fullName, options = {}) {
    const { token, timeoutMs = 30000, now = Date.now() } = options;
    const [owner, name] = String(fullName).split('/');
    const url = `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/releases/latest`;
    const { status, json } = await fetchJson(url, {
        timeoutMs,
        headers: githubHeaders(token),
        allowStatuses: [404],
        retries: 1,
    });
    if (status !== 200 || !json) {
        return { latestReleaseTag: null, latestReleaseAt: null, daysSinceLastRelease: null, hasPublishedReleases: false };
    }
    return {
        latestReleaseTag: json.tag_name ?? null,
        latestReleaseAt: json.published_at ?? null,
        daysSinceLastRelease: daysBetween(json.published_at, now),
        hasPublishedReleases: true,
    };
}

/** The remaining hourly allowance, read without spending any of it. */
export async function fetchRateLimit(options = {}) {
    const { token, timeoutMs = 15000 } = options;
    try {
        const { json } = await fetchJson(`${API}/rate_limit`, { timeoutMs, headers: githubHeaders(token), retries: 0 });
        const core = json?.resources?.core ?? json?.rate ?? null;
        if (!core) return null;
        return {
            limit: core.limit ?? null,
            remaining: core.remaining ?? null,
            resetAt: core.reset ? new Date(core.reset * 1000).toISOString() : null,
            authenticated: (core.limit ?? 0) > 60,
        };
    } catch {
        return null;
    }
}
