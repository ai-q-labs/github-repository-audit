/**
 * Turning two half-pictures into findings.
 *
 * Everything here is a rule over facts already collected; nothing fetches and
 * nothing guesses. Three principles decide what becomes a finding:
 *
 * 1. A finding needs a disagreement or a declaration, never an inference alone.
 *    "Archived" is the maintainer saying the project is over. "No push in a
 *    year" is me deciding that, so it is reported at a lower severity and never
 *    used as the basis of the headline finding.
 * 2. An unknown stays unknown. Where a licence could not be resolved on either
 *    side, the verdict is `null` and no finding is produced - a false "your
 *    licence changed" costs a lawyer's afternoon.
 * 3. A warning that fires on healthy dependencies is worse than no warning,
 *    because it buries the row that mattered.
 */

import { isSourceAvailableLicense, normalizeLicense, verdictFromIds } from './parse.js';

export const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'];

const SEVERITY_OF = {
    repo_gone: 'critical',
    repo_archived: 'critical',
    silent_abandonment: 'critical',
    license_mismatch: 'critical',
    release_yanked: 'critical',

    deprecated_on_registry: 'high',
    license_now_source_available: 'high',
    known_vulnerabilities: 'high',

    repo_moved: 'medium',
    stale_no_push: 'medium',
    license_declared_but_absent: 'medium',
    fork_behind_upstream: 'medium',
    single_maintainer: 'medium',

    // Deliberately low. Measured against real dependencies, GitHub fails to
    // classify the licence file of lodash, jQuery UI and UglifyJS - all of them
    // perfectly ordinary MIT/BSD projects whose LICENSE carries an extra
    // paragraph. Raising this would put a warning on healthy rows and bury the
    // ones that matter.
    license_needs_review: 'low',
    no_license_file: 'low',
    issues_disabled: 'low',
    no_repository_link: 'low',
    repository_not_on_github: 'low',
    not_checked: 'low',
};

export function severityOf(code) {
    return SEVERITY_OF[code] ?? 'low';
}

function worst(codes) {
    for (const level of SEVERITY_ORDER) {
        if (codes.some((c) => severityOf(c) === level)) return level;
    }
    return 'ok';
}

/**
 * @param {object} target       what was asked for: {source, requestedRepo, registry, packageName, spec, directory}
 * @param {object|null} pkg     the registry record, when the input named a package
 * @param {object|null} repo    the GitHub record, when a repository could be identified
 * @param {{staleAfterDays?: number, singleMaintainerShare?: number}} [config]
 */
export function auditOne(target, pkg, repo, config = {}) {
    const { staleAfterDays = 365, singleMaintainerShare = 0.9 } = config;
    const issues = [];
    const add = (code, detail) => issues.push({ code, severity: severityOf(code), detail });

    const registryFound = pkg?.found === true;
    const declaredIds = registryFound ? (pkg.declaredLicenseIds ?? []) : [];
    const repoLicense = repo?.exists ? (repo.repoLicenseSpdx ?? repo.repoLicenseName ?? null) : null;
    const repoLicenseIds = normalizeLicense(repo?.repoLicenseSpdx ?? null).ids;

    // --- what the registry admits -----------------------------------------
    if (registryFound && pkg.deprecated === true) {
        add('deprecated_on_registry', pkg.deprecationMessage
            ? `The registry marks this deprecated: "${pkg.deprecationMessage}"`
            : 'The registry marks this package deprecated.');
    }
    if (registryFound && pkg.yanked === true) {
        add('release_yanked', pkg.yankedReason
            ? `Version ${pkg.version} has been yanked: "${pkg.yankedReason}"`
            : `Version ${pkg.version} has been yanked from the registry.`);
    }
    if (registryFound && Number(pkg.knownVulnerabilities) > 0) {
        add('known_vulnerabilities', `The registry lists ${pkg.knownVulnerabilities} known vulnerability record(s) for version ${pkg.version}.`);
    }
    if (registryFound && !pkg.repoUrl) {
        add('no_repository_link', 'The registry record does not link to any source repository, so nothing can be verified against it.');
    } else if (registryFound && pkg.repoUrl && !repo) {
        add('repository_not_on_github', `The registry links to ${String(pkg.repoUrl).slice(0, 120)}, which is not a GitHub repository.`);
    }

    // --- what the repository shows -----------------------------------------
    if (repo && repo.exists === false) {
        add('repo_gone', `GitHub returns 404 for ${repo.requestedRepo} (${repo.notFoundReason}).`);
    }

    if (repo?.exists) {
        if (repo.moved) {
            add('repo_moved', `${repo.requestedRepo} now answers as ${repo.resolvedRepo} (${repo.moveKind}). `
                + 'GitHub follows the change silently, so requests keep returning 200 and nothing tells you the owner changed.');
        }
        if (repo.archived) {
            add('repo_archived', `${repo.resolvedRepo} is archived: read-only, no fixes and no security patches.`);
        } else if (Number.isFinite(repo.daysSinceLastPush) && repo.daysSinceLastPush > staleAfterDays) {
            add('stale_no_push', `No commit pushed to ${repo.resolvedRepo} for ${repo.daysSinceLastPush} days (threshold ${staleAfterDays}).`);
        }
        if (repo.disabled) {
            add('repo_archived', `${repo.resolvedRepo} has been disabled by GitHub.`);
        }
        if (repo.isFork && repo.parentRepo && repo.parentPushedAt && repo.pushedAt
            && Date.parse(repo.parentPushedAt) > Date.parse(repo.pushedAt)) {
            add('fork_behind_upstream', `This is a fork of ${repo.parentRepo}, and the upstream has been pushed to more recently.`);
        }
        if (repo.repoHasNoLicenseFile) {
            // One fact, one finding. Where the registry made a claim, the interesting
            // half is the contradiction, not the absence on its own.
            if (declaredIds.length) {
                add('license_declared_but_absent', `The registry declares "${pkg.declaredLicense}", but GitHub finds no licence file in ${repo.resolvedRepo}. `
                    + 'The grant of rights exists only in the package metadata, with nothing in the source to back it.');
            } else {
                add('no_license_file', 'GitHub finds no licence file in the repository, so the code carries no explicit grant of rights.');
            }
        } else if (repo.repoLicenseNonStandard) {
            add('license_needs_review', `GitHub cannot match the licence file in ${repo.resolvedRepo} to a standard licence (it reports "${repo.repoLicenseName ?? 'Other'}"). `
                + 'This is common and usually harmless - lodash and jQuery UI both land here because their MIT text carries an extra paragraph - '
                + 'but a relicensing to BUSL or SSPL is indistinguishable from the outside, so the file is worth reading once.');
        }
        if (isSourceAvailableLicense(repoLicenseIds)) {
            add('license_now_source_available', `The repository is under ${repoLicenseIds.join(' / ')}, which is source-available rather than open source.`);
        }
        if (repo.hasIssuesEnabled === false) {
            add('issues_disabled', 'The issue tracker is turned off, so there is no public channel to report a bug.');
        }
        if (Number.isFinite(repo.topContributorShare) && repo.topContributorShare >= singleMaintainerShare) {
            add('single_maintainer', `${repo.topContributor} accounts for ${Math.round(repo.topContributorShare * 100)}% of the recorded commits.`);
        }
    }

    // --- where the two disagree --------------------------------------------
    // Compared as resolved identifiers, never as the strings they were rendered
    // from: PyPI's licence usually only resolves through its classifiers, and
    // turning that answer back into text to re-parse it throws the answer away.
    const verdict = registryFound && repo?.exists
        ? verdictFromIds(declaredIds, repoLicenseIds)
        : null;
    if (verdict === 'mismatch') {
        add('license_mismatch', `The registry declares "${pkg.declaredLicense}" for version ${pkg.version}, `
            + `but the repository is under "${repo.repoLicenseSpdx}". One of the two changed after the other.`);
    }

    // The headline. Both halves have to be true at once: the registry saying
    // nothing is wrong, and the maintainer having declared the project finished.
    const registrySilent = registryFound && pkg.deprecated !== true && pkg.yanked !== true;
    const repoOver = repo?.exists === true && (repo.archived === true || repo.disabled === true);
    const silentAbandonment = Boolean(registrySilent && repoOver);
    if (silentAbandonment) {
        add('silent_abandonment', `${pkg.registry} still serves ${pkg.name}@${pkg.version} with no deprecation notice, `
            + `while its repository ${repo.resolvedRepo} has been archived. Installing it looks completely normal.`);
    }

    const codes = issues.map((i) => i.code);
    return {
        ...target,
        registry: pkg?.registry ?? target.registry ?? null,
        packageName: pkg?.name ?? target.packageName ?? null,
        packageFound: registryFound ? true : (pkg ? false : null),
        packageVersion: registryFound ? pkg.version : null,
        packageVersionResolvedFrom: registryFound ? pkg.resolvedFrom : null,
        declaredLicense: registryFound ? pkg.declaredLicense : null,
        declaredLicenseIds: declaredIds,
        declaredLicenseSource: registryFound ? (pkg.declaredLicenseSource ?? null) : null,
        registryDeprecated: registryFound ? pkg.deprecated : null,
        registryDeprecationMessage: registryFound ? pkg.deprecationMessage : null,
        registryYanked: registryFound ? pkg.yanked : null,
        registryRepoUrl: registryFound ? pkg.repoUrl : null,
        registryRepoDirectory: registryFound ? pkg.repoDirectory : null,
        knownVulnerabilities: registryFound ? pkg.knownVulnerabilities : null,

        repoChecked: Boolean(repo),
        repoExists: repo ? repo.exists : null,
        requestedRepo: repo?.requestedRepo ?? target.requestedRepo ?? null,
        resolvedRepo: repo?.resolvedRepo ?? null,
        repoUrl: repo?.htmlUrl ?? null,
        moved: repo?.exists ? repo.moved : null,
        moveKind: repo?.exists ? repo.moveKind : null,
        archived: repo?.exists ? repo.archived : null,
        disabled: repo?.exists ? repo.disabled : null,
        isFork: repo?.exists ? repo.isFork : null,
        parentRepo: repo?.exists ? repo.parentRepo : null,
        pushedAt: repo?.exists ? repo.pushedAt : null,
        daysSinceLastPush: repo?.exists ? repo.daysSinceLastPush : null,
        stars: repo?.exists ? repo.stars : null,
        forks: repo?.exists ? repo.forks : null,
        openIssues: repo?.exists ? repo.openIssues : null,
        hasIssuesEnabled: repo?.exists ? repo.hasIssuesEnabled : null,
        repoLicense: repoLicense,
        repoLicenseSpdx: repo?.exists ? repo.repoLicenseSpdx : null,
        repoLicenseNonStandard: repo?.exists ? repo.repoLicenseNonStandard : null,
        contributorCount: repo?.contributorCount ?? null,
        // GitHub's contributor list is paginated at 100. Without this flag a row
        // saying "100 contributors" reads as an exact count when it means "at least".
        contributorCountIsCapped: repo?.contributorCountIsCapped ?? null,
        topContributor: repo?.topContributor ?? null,
        topContributorShare: repo?.topContributorShare ?? null,
        latestReleaseTag: repo?.latestReleaseTag ?? null,
        latestReleaseAt: repo?.latestReleaseAt ?? null,
        daysSinceLastRelease: repo?.daysSinceLastRelease ?? null,

        // `null`, not `false`, whenever one of the two sides could not be read.
        licenseMatch: verdict === null ? null : verdict === 'match',
        silentAbandonment: registryFound && repo?.exists ? silentAbandonment : null,

        riskLevel: worst(codes),
        issueCodes: codes,
        issues,
    };
}

/** Rows worth acting on, hardest problems first, ties broken by popularity. */
export function actionList(rows, limit = 100) {
    const rank = (level) => {
        const i = SEVERITY_ORDER.indexOf(level);
        return i === -1 ? SEVERITY_ORDER.length : i;
    };
    return rows
        .filter((r) => r.riskLevel !== 'ok')
        .sort((a, b) => rank(a.riskLevel) - rank(b.riskLevel)
            || (b.stars ?? 0) - (a.stars ?? 0)
            || String(a.resolvedRepo ?? a.requestedRepo ?? '').localeCompare(String(b.resolvedRepo ?? b.requestedRepo ?? '')))
        .slice(0, limit)
        .map((r) => ({
            // input and source lead because this list is sorted by severity, so the
            // caller's own target can end up below entries they never named. A reader
            // who cannot answer "did I ask for this?" cannot act on the row.
            input: r.input,
            source: r.source,
            target: r.packageName ?? r.requestedRepo,
            registry: r.registry,
            repo: r.resolvedRepo ?? r.requestedRepo,
            riskLevel: r.riskLevel,
            issues: r.issues.map((i) => `[${i.severity}] ${i.code}: ${i.detail}`),
        }));
}

/** What is actually in the dependency tree, licence by licence. */
export function licenseReport(rows) {
    const counts = new Map();
    const unresolved = [];
    for (const row of rows) {
        // A repository that answers 404 has no licence file to go and read. Listing
        // it here turns the "check these by hand" list into a list of dead errands.
        if (row.repoExists === false) continue;
        const ids = row.repoLicenseSpdx
            ? [row.repoLicenseSpdx]
            : (row.declaredLicenseIds?.length ? row.declaredLicenseIds : []);
        if (!ids.length) {
            // This is a list of licence files to go and open by hand, so it has to say
            // which entries the caller actually named. Sending someone to read a licence
            // for a dependency they never asked about is the same waste as a false finding.
            unresolved.push({
                input: row.input,
                source: row.source,
                target: row.packageName ?? row.requestedRepo,
            });
            continue;
        }
        for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return {
        byLicense: [...counts.entries()]
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .map(([license, count]) => ({ license, count, sourceAvailable: isSourceAvailableLicense([license]) })),
        // Named rather than counted: an unresolved licence is a thing to go and read,
        // not a statistic.
        unresolved: unresolved.slice(0, 200),
        unresolvedCount: unresolved.length,
    };
}

export function summarize(rows, extra = {}) {
    const count = (fn) => rows.filter(fn).length;
    const codeCounts = {};
    for (const row of rows) {
        for (const code of row.issueCodes ?? []) codeCounts[code] = (codeCounts[code] ?? 0) + 1;
    }
    const withBothSides = rows.filter((r) => r.licenseMatch !== null).length;
    // A single call can mix targets the caller typed with targets that arrived some
    // other way - a manifest that expanded into forty dependencies, or a schema
    // default. A flat count of "2 critical" cannot be acted on, because it does not
    // say whose. Every count here is repeated per source so the caller can subtract
    // the rows they did not name.
    const bySource = {};
    for (const row of rows) {
        const key = row.source ?? 'unknown';
        bySource[key] ??= { checked: 0, critical: 0, high: 0, medium: 0, low: 0, ok: 0 };
        bySource[key].checked += 1;
        if (row.riskLevel in bySource[key]) bySource[key][row.riskLevel] += 1;
    }
    return {
        checked: rows.length,
        bySource,
        byRiskLevel: {
            critical: count((r) => r.riskLevel === 'critical'),
            high: count((r) => r.riskLevel === 'high'),
            medium: count((r) => r.riskLevel === 'medium'),
            low: count((r) => r.riskLevel === 'low'),
            ok: count((r) => r.riskLevel === 'ok'),
        },
        findings: codeCounts,
        licenseComparison: {
            comparable: withBothSides,
            // A rate over a denominator of zero is null, not 0: "nothing could be
            // compared" and "nothing mismatched" are different answers.
            mismatchRate: withBothSides ? Number((count((r) => r.licenseMatch === false) / withBothSides).toFixed(3)) : null,
            notComparable: rows.length - withBothSides,
        },
        ...extra,
    };
}
