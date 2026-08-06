/**
 * Live checks against the real npm registry, the real PyPI and the real GitHub API.
 *
 * Every case here was found by looking, not by imagining: each one is a package
 * or repository that behaves this way today, with a negative control beside it
 * so a rule that fires on everything cannot pass.
 *
 * Costs about a dozen GitHub requests. Unauthenticated callers get 60 an hour
 * per IP, so set GITHUB_TOKEN if you intend to run this repeatedly:
 *
 *     GITHUB_TOKEN=ghp_... npm run test:live
 */

import { auditOne, licenseReport, summarize } from '../src/audit.js';
import { fetchRateLimit, fetchRepo } from '../src/github.js';
import { parseRepoRef } from '../src/parse.js';
import { lookupPackage, repoFromRegistry } from '../src/registry.js';

const token = process.env.GITHUB_TOKEN || null;
let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
    if (condition) {
        passed += 1;
        console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
    } else {
        failed += 1;
        console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    }
}

const repoCache = new Map();
async function repoOf(full) {
    const key = full.toLowerCase();
    if (!repoCache.has(key)) {
        repoCache.set(key, await fetchRepo(parseRepoRef(full), { token }));
    }
    return repoCache.get(key);
}

async function auditPackage(registry, name, spec) {
    const pkg = await lookupPackage(registry, name, spec);
    const ref = repoFromRegistry(pkg);
    const repo = ref ? await repoOf(ref.full) : null;
    return { pkg, repo, row: auditOne({ registry, packageName: name }, pkg, repo) };
}

console.log('\n--- allowance -------------------------------------------------------');
const budget = await fetchRateLimit({ token });
console.log(`  GitHub: ${budget?.remaining}/${budget?.limit} left, resets ${budget?.resetAt}`
    + `${token ? ' (token in use)' : ' (no token)'}`);
if (budget && budget.remaining !== null && budget.remaining < 12) {
    console.error(`\n  Only ${budget.remaining} GitHub requests left this hour; this check needs about 12.`);
    console.error('  Wait for the reset or set GITHUB_TOKEN.\n');
    process.exit(2);
}

console.log('\n--- the headline: served by the registry, archived on GitHub --------');
{
    const { pkg, repo, row } = await auditPackage('npm', 'cross-env');
    check('cross-env is not marked deprecated on npm', pkg.deprecated === false, `deprecated=${pkg.deprecated}`);
    check('its repository is archived', repo?.archived === true, `${repo?.resolvedRepo} archived=${repo?.archived}`);
    check('so the audit calls it a silent abandonment', row.silentAbandonment === true);
    check('and ranks it critical', row.riskLevel === 'critical', row.issueCodes.join(', '));
}

console.log('\n--- the control: archived AND announced is not silent ---------------');
{
    const { pkg, repo, row } = await auditPackage('npm', 'babel-eslint');
    check('babel-eslint is deprecated on npm', pkg.deprecated === true);
    check('its repository is archived too', repo?.archived === true, `${repo?.resolvedRepo}`);
    check('the audit does NOT call this silent', row.silentAbandonment === false,
        'a maintainer who deprecated the package hid nothing');
    check('but it is still reported', row.issueCodes.includes('repo_archived') && row.issueCodes.includes('deprecated_on_registry'));
}

console.log('\n--- repositories that moved without saying so -----------------------');
{
    const cra = await repoOf('facebook/create-react-app');
    check('facebook/create-react-app answers 200', cra.exists === true, `HTTP ${cra.httpStatus}`);
    check('but it is really react/create-react-app now', cra.resolvedRepo === 'react/create-react-app', cra.resolvedRepo);
    check('and the audit reports the move', cra.moved === true && cra.moveKind === 'transferred', `moveKind=${cra.moveKind}`);

    const { pkg, repo, row } = await auditPackage('npm', 'enzyme');
    check('npm still points enzyme at the old owner', /airbnb\/enzyme/i.test(String(pkg.repoUrl)), String(pkg.repoUrl));
    check('which now resolves elsewhere', repo?.resolvedRepo === 'enzymejs/enzyme', repo?.resolvedRepo);
    check('so the row carries repo_moved', row.issueCodes.includes('repo_moved'));
}

console.log('\n--- a case difference is not a move ---------------------------------');
{
    const ts = await repoOf('Microsoft/typescript');
    check('Microsoft/typescript resolves to microsoft/TypeScript', ts.resolvedRepo === 'microsoft/TypeScript', ts.resolvedRepo);
    check('and is NOT reported as moved', ts.moved === false, 'GitHub is case-insensitive on both halves');
}

console.log('\n--- licences ---------------------------------------------------------');
{
    const { pkg, repo, row } = await auditPackage('npm', 'nightmare');
    check('npm declares a licence for nightmare', pkg.declaredLicenseIds.length > 0, pkg.declaredLicense);
    check('the repository has no licence file', repo?.repoHasNoLicenseFile === true, repo?.resolvedRepo);
    check('reported as declared-but-absent, not as a plain missing licence',
        row.issueCodes.includes('license_declared_but_absent') && !row.issueCodes.includes('no_license_file'));
    check('and no licence mismatch is invented', row.licenseMatch === null, 'nothing to compare against');
}
{
    const { pkg, repo, row } = await auditPackage('npm', 'jquery-ui');
    check('npm declares MIT for jquery-ui', pkg.declaredLicenseIds.includes('MIT'), pkg.declaredLicense);
    check('GitHub cannot classify the licence file', repo?.repoLicenseNonStandard === true, repo?.repoLicenseName);
    check('so it is flagged for manual review', row.issueCodes.includes('license_needs_review'));
    check('at low severity, not as an alarm', row.riskLevel === 'low', row.riskLevel);
    check('and still no mismatch is claimed', row.licenseMatch === null,
        'an unclassifiable licence is unknown, not different');
}
{
    const tf = await repoOf('hashicorp/terraform');
    check('terraform reports a non-standard licence', tf.repoLicenseNonStandard === true, `spdx=${tf.repoLicenseSpdx} name=${tf.repoLicenseName}`);
}

console.log('\n--- PyPI ------------------------------------------------------------');
{
    const { pkg, repo, row } = await auditPackage('pypi', 'requests', '==2.31.0');
    check('the pinned version is read, not the newest', pkg.version === '2.31.0' && pkg.resolvedFrom === 'pinned', `${pkg.version} (${pkg.resolvedFrom})`);
    check('the licence comes out of the classifiers', pkg.declaredLicenseIds.length > 0, `${pkg.declaredLicense}`);
    check('the source repository is found in project_urls', repo?.resolvedRepo === 'psf/requests', repo?.resolvedRepo);
    check('Apache on both sides is a match, not a mismatch', row.licenseMatch === true, `${pkg.declaredLicense} vs ${repo?.repoLicenseSpdx}`);
}
{
    const pkg = await lookupPackage('pypi', 'nose');
    check('a free-text licence that resolves to a family still resolves', pkg.declaredLicenseIds.length > 0, `${pkg.declaredLicense}`);
}

console.log('\n--- negative controls: healthy dependencies stay quiet ---------------');
{
    const clean = [];
    for (const name of ['express', 'chalk']) {
        const { row } = await auditPackage('npm', name);
        clean.push([name, row]);
        check(`${name} produces no findings at all`, row.riskLevel === 'ok', row.issueCodes.join(', ') || 'no issues');
    }
    check('and their licences compare as matching', clean.every(([, r]) => r.licenseMatch === true));
}
{
    // The calibration case. lodash is as healthy as a dependency gets, but its
    // LICENSE carries a CC0 addendum GitHub cannot classify. If that note ever
    // outranks "low" it will sit above the rows that matter.
    const { row } = await auditPackage('npm', 'lodash');
    check('lodash raises only the manual-review note', row.issueCodes.join(',') === 'license_needs_review', row.issueCodes.join(', '));
    check('and it stays at the bottom of the ranking', row.riskLevel === 'low', row.riskLevel);
}

console.log('\n--- a repository that is not there ----------------------------------');
{
    const gone = await repoOf('aiqlabs/definitely-not-a-real-repository-xyz');
    check('missing repositories come back as data, not as an exception', gone.exists === false, `HTTP ${gone.httpStatus}`);
    check('and the reason does not overclaim', /private/.test(String(gone.notFoundReason)) || Boolean(token), gone.notFoundReason);
}

console.log('\n--- monorepo deduplication ------------------------------------------');
{
    const babelCore = await lookupPackage('npm', '@babel/core');
    check('a scoped package name is encoded correctly', babelCore.found === true, `@babel/core -> ${babelCore.version}`);
    check('and it points at the monorepo, not a package of its own',
        repoFromRegistry(babelCore)?.full === 'babel/babel', repoFromRegistry(babelCore)?.full);
    check('with the package directory kept', babelCore.repoDirectory === 'packages/babel-core', String(babelCore.repoDirectory));
}

console.log('\n--- reports ---------------------------------------------------------');
{
    const rows = [];
    for (const [key, record] of repoCache) {
        if (record.exists) rows.push(auditOne({ requestedRepo: key }, null, record));
    }
    const stats = summarize(rows);
    check('the summary counts every row it was given', stats.checked === rows.length, `${stats.checked} rows`);
    check('a licence mismatch rate over an empty denominator is null', stats.licenseComparison.mismatchRate === null,
        'no registry side was supplied to these rows');
    const report = licenseReport(rows);
    check('the licence inventory is not empty', report.byLicense.length > 0,
        report.byLicense.map((l) => `${l.license}:${l.count}`).join(' '));
}

const after = await fetchRateLimit({ token });
console.log(`\n${passed} passed, ${failed} failed. GitHub allowance now ${after?.remaining}/${after?.limit}.\n`);
process.exit(failed ? 1 : 0);
