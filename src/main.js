import { Actor, log } from 'apify';

import { actionList, auditOne, licenseReport, summarize } from './audit.js';
import { fetchBusFactor, fetchLatestRelease, fetchRateLimit, fetchRepo } from './github.js';
import { RateLimitError, runPool } from './http.js';
import { installHttpCrashGuard } from './httpguard.js';
import { parseRepoRef } from './parse.js';
import { lookupPackage, repoFromRegistry } from './registry.js';
import { buildTargets } from './targets.js';

// Must be installed before the first request. See httpguard.js for what it
// catches and why swallowing that one assertion is safe.
installHttpCrashGuard(log);

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    repos = [],
    packages = [],
    defaultRegistry = 'npm',
    manifestUrl = '',
    manifestText = '',
    manifestType = '',
    manifestGroups = ['dependencies'],
    githubToken = '',
    staleAfterDays = 365,
    includeContributors = false,
    includeReleases = false,
    onlyIssues = false,
    maxTargets = 200,
    maxConcurrency = 4,
    requestTimeoutSecs = 30,
} = input;

const asList = (v) => (Array.isArray(v) ? v : [v])
    .flatMap((x) => String(x ?? '').split(/[\s,]+/))
    .map((x) => x.trim())
    .filter(Boolean);

const timeoutMs = Math.max(5, Math.min(180, Number(requestTimeoutSecs) || 30)) * 1000;
const concurrency = Math.max(1, Math.min(10, Number(maxConcurrency) || 4));
const cap = Math.max(1, Math.min(2000, Number(maxTargets) || 200));
const staleDays = Math.max(30, Math.min(3650, Number(staleAfterDays) || 365));
const token = String(githubToken || '').trim() || null;

const notes = [];
let built;
try {
    built = await buildTargets({
        repos: asList(repos),
        packages: Array.isArray(packages) ? packages.map((p) => String(p).trim()).filter(Boolean) : asList(packages),
        defaultRegistry,
        manifestUrl: String(manifestUrl || '').trim(),
        manifestText,
        manifestType,
        manifestGroups: Array.isArray(manifestGroups) ? manifestGroups : [manifestGroups],
        timeoutMs,
    });
} catch (err) {
    await Actor.fail(`Could not read the input: ${String(err?.message || err)}`);
}

notes.push(...built.notes);
let targets = built.targets;
if (!targets.length) {
    await Actor.fail('Nothing to audit. Give me some repositories, some package names, or a dependency manifest.');
}
if (targets.length > cap) {
    notes.push(`Input held ${targets.length} entries; only the first ${cap} were audited (maxTargets).`);
    targets = targets.slice(0, cap);
}

log.info(`Auditing ${targets.length} target(s).`);

// --- 1. what the registries declare ----------------------------------------
const registryTargets = targets.map((t, i) => ({ t, i })).filter(({ t }) => t.registry && t.packageName);
const registryRecords = new Array(targets.length).fill(null);
if (registryTargets.length) {
    log.info(`Reading ${registryTargets.length} package record(s) from npm/PyPI.`);
    const results = await runPool(registryTargets, Math.min(8, concurrency * 2), async ({ t }) =>
        lookupPackage(t.registry, t.packageName, t.spec, { timeoutMs }));
    registryTargets.forEach(({ i }, k) => { registryRecords[i] = results[k]; });
}

// --- 2. which repositories those point at ----------------------------------
const refByTarget = new Array(targets.length).fill(null);
const uniqueRepos = new Map(); // lowercased full name -> ref
targets.forEach((t, i) => {
    let ref = null;
    if (t.requestedRepo) {
        const parsed = parseRepoRef(t.requestedRepo);
        if (parsed.ok) ref = parsed;
    }
    if (!ref) ref = repoFromRegistry(registryRecords[i]);
    if (!ref) return;
    refByTarget[i] = ref;
    const key = ref.full.toLowerCase();
    if (!uniqueRepos.has(key)) uniqueRepos.set(key, ref);
});

const repoRefs = [...uniqueRepos.values()];
log.info(`${repoRefs.length} distinct GitHub repositor${repoRefs.length === 1 ? 'y' : 'ies'} behind those targets.`);

// --- 3. read GitHub, within whatever allowance is left ----------------------
const budget = await fetchRateLimit({ token, timeoutMs });
const perRepoCost = 1 + (includeContributors ? 1 : 0) + (includeReleases ? 1 : 0);
if (budget) {
    log.info(`GitHub allowance: ${budget.remaining}/${budget.limit} left, resets ${budget.resetAt}`
        + `${budget.authenticated ? ' (token in use)' : ' (no token: 60/hour, shared with everything else on this IP)'}.`);
    const needed = repoRefs.length * perRepoCost;
    if (budget.remaining !== null && needed > budget.remaining) {
        notes.push(`This run needs about ${needed} GitHub requests but only ${budget.remaining} are left `
            + `before ${budget.resetAt}. Repositories beyond that point are reported as not checked. `
            + `${token ? '' : 'Supplying a githubToken raises the limit from 60 to 5,000 requests an hour.'}`);
    }
}

const state = { rateLimited: false, resetAt: budget?.resetAt ?? null, skipped: 0, requests: 0 };
const repoRecords = new Map();

await runPool(repoRefs, concurrency, async (ref) => {
    if (state.rateLimited) { state.skipped += 1; return null; }
    try {
        const record = await fetchRepo(ref, { token, timeoutMs });
        state.requests += 1;
        // The optional checks get their own guard. They are extras, and losing one
        // must never throw away the repository record that was already paid for.
        if (record.exists && !state.rateLimited && (includeContributors || includeReleases)) {
            try {
                if (includeContributors) {
                    Object.assign(record, await fetchBusFactor(record.resolvedRepo, { token, timeoutMs }));
                    state.requests += 1;
                }
                if (includeReleases) {
                    Object.assign(record, await fetchLatestRelease(record.resolvedRepo, { token, timeoutMs }));
                    state.requests += 1;
                }
            } catch (err) {
                if (err instanceof RateLimitError && !state.rateLimited) {
                    state.rateLimited = true;
                    state.resetAt = err.resetAt ?? state.resetAt;
                    log.warning(`${err.message} The repository records already collected are kept; the optional checks stop here.`);
                }
                record.extraChecksNote = String(err?.message || err).slice(0, 200);
            }
        }
        repoRecords.set(ref.full.toLowerCase(), record);
        return record;
    } catch (err) {
        if (err instanceof RateLimitError) {
            if (!state.rateLimited) {
                state.rateLimited = true;
                state.resetAt = err.resetAt ?? state.resetAt;
                log.warning(`${err.message} Everything collected so far is kept; the rest is reported as not checked.`);
            }
            state.skipped += 1;
            return null;
        }
        repoRecords.set(ref.full.toLowerCase(), {
            requestedRepo: ref.full,
            exists: null,
            httpStatus: null,
            error: String(err?.message || err).slice(0, 200),
        });
        return null;
    }
});

if (state.rateLimited) {
    notes.push(`GitHub's hourly allowance ran out after ${state.requests} request(s); `
        + `${state.skipped} repositor${state.skipped === 1 ? 'y was' : 'ies were'} left unchecked until ${state.resetAt ?? 'the next reset'}. `
        + `${token ? '' : 'Add a githubToken to raise the limit from 60 to 5,000 requests an hour.'}`);
}

// --- 4. combine ------------------------------------------------------------
const checkedAt = new Date().toISOString();
const rows = targets.map((t, i) => {
    const ref = refByTarget[i];
    const repo = ref ? (repoRecords.get(ref.full.toLowerCase()) ?? null) : null;
    const row = auditOne(
        {
            source: t.source,
            input: t.input,
            requestedRepo: ref?.full ?? t.requestedRepo ?? null,
            directory: t.directory ?? null,
            dependencyGroup: t.group ?? null,
            declaredSpec: t.spec ?? null,
            registry: t.registry ?? null,
            packageName: t.packageName ?? null,
        },
        registryRecords[i],
        repo,
        { staleAfterDays: staleDays },
    );
    if (ref && !repo) {
        row.issues.push({
            code: 'not_checked',
            severity: 'low',
            detail: state.rateLimited
                ? `${ref.full} was not checked: GitHub's hourly allowance ran out.`
                : `${ref.full} could not be read from GitHub.`,
        });
        row.issueCodes.push('not_checked');
        if (row.riskLevel === 'ok') row.riskLevel = 'low';
    }
    return { ...row, checkedAt };
});

// A row that came in as a repository has no registry side, so three checks cannot
// run on it: deprecation, licence comparison, and the headline silent-abandonment
// finding. Those fields come back null, which is honest but silent. Saying nothing
// lets a caller read "no deprecation finding" as "not deprecated", and the two are
// not the same answer. Name the gap and say how to close it.
const repoOnly = rows.filter((r) => r.source === 'repos' && r.packageFound === null);
if (repoOnly.length) {
    notes.push(`${repoOnly.length} target(s) were given as repositories, so no registry was consulted for them. `
        + 'registryDeprecated, licenseMatch and silentAbandonment are null on those rows because they could not '
        + 'be checked, not because they came back clean. Pass the package name to check them.');
}

const output = onlyIssues ? rows.filter((r) => r.riskLevel !== 'ok') : rows;
for (const row of output) await Actor.pushData(row);

await Actor.setValue('SUMMARY', summarize(rows, {
    query: {
        repos: asList(repos).length,
        packages: Array.isArray(packages) ? packages.length : 0,
        manifest: manifestType || (manifestUrl ? manifestUrl : null),
        staleAfterDays: staleDays,
        includeContributors,
        includeReleases,
    },
    github: {
        authenticated: Boolean(token),
        requestsMade: state.requests,
        distinctRepositories: repoRefs.length,
        repositoriesNotChecked: state.skipped,
        rateLimited: state.rateLimited,
        allowanceResetsAt: state.resetAt,
    },
    notes,
    generatedAt: checkedAt,
}));
await Actor.setValue('ACTION_LIST', actionList(rows, 200));
await Actor.setValue('LICENSE_REPORT', licenseReport(rows));

const stats = summarize(rows);
log.info(
    `Done. ${stats.checked} target(s): ${stats.byRiskLevel.critical} critical, ${stats.byRiskLevel.high} high, `
    + `${stats.byRiskLevel.medium} medium, ${stats.byRiskLevel.low} low, ${stats.byRiskLevel.ok} with nothing to report.`,
);
const headline = stats.findings.silent_abandonment ?? 0;
if (headline) {
    log.info(`${headline} dependenc${headline === 1 ? 'y is' : 'ies are'} still served by the registry with no deprecation notice `
        + 'while their repositories are archived.');
}
log.info('Ranked findings are in ACTION_LIST, the licence inventory in LICENSE_REPORT, counts and caveats in SUMMARY.');

await Actor.exit();
