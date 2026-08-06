import assert from 'node:assert/strict';
import test from 'node:test';

import { actionList, auditOne, licenseReport, severityOf, summarize } from '../src/audit.js';
import { daysBetween } from '../src/github.js';
import { fetchJson, isQuotaExhausted, readRateLimit, retryAfterMs } from '../src/http.js';
import { installHttpCrashGuard, isUndiciParserAssertion } from '../src/httpguard.js';
import {
    detectManifestType,
    licenseFromClassifiers,
    licenseVerdict,
    licensesCompatible,
    normalizeLicense,
    parseManifest,
    parsePackageRef,
    parseRepoRef,
    sameRepo,
    verdictFromIds,
} from '../src/parse.js';
import { pinnedVersion } from '../src/registry.js';
import { buildTargets, targetsFromManifest, targetsFromRepos } from '../src/targets.js';

// ---------------------------------------------------------------------------
// Repository references
// ---------------------------------------------------------------------------

test('parseRepoRef accepts every shape a repository reference arrives in', () => {
    const cases = [
        ['owner/name', 'owner/name'],
        ['https://github.com/owner/name', 'owner/name'],
        ['https://www.github.com/owner/name/', 'owner/name'],
        ['https://github.com/owner/name.git', 'owner/name'],
        ['git+https://github.com/owner/name.git', 'owner/name'],
        ['git+ssh://git@github.com/owner/name.git', 'owner/name'],
        ['git@github.com:owner/name.git', 'owner/name'],
        ['github:owner/name', 'owner/name'],
        ['git://github.com/owner/name.git', 'owner/name'],
        ['github.com/owner/name', 'owner/name'],
        ['owner/name.js', 'owner/name.js'],
    ];
    for (const [input, expected] of cases) {
        const parsed = parseRepoRef(input);
        assert.equal(parsed.ok, true, `${input} should parse`);
        assert.equal(parsed.full, expected, input);
    }
});

test('parseRepoRef keeps the package directory out of a monorepo tree URL', () => {
    const parsed = parseRepoRef('https://github.com/babel/babel/tree/main/packages/babel-core');
    assert.equal(parsed.full, 'babel/babel');
    assert.equal(parsed.directory, 'packages/babel-core');
});

test('parseRepoRef refuses anything that is not on GitHub', () => {
    for (const input of ['https://gitlab.com/a/b', 'gitlab.com/a/b', 'git@bitbucket.org:a/b.git']) {
        const parsed = parseRepoRef(input);
        assert.equal(parsed.ok, false, input);
        assert.match(parsed.reason, /not hosted on GitHub/);
    }
});

test('parseRepoRef rejects incomplete and malformed references', () => {
    for (const input of ['', '   ', 'justaname', 'https://github.com/owner', 'owner/', 'owner/..']) {
        assert.equal(parseRepoRef(input).ok, false, JSON.stringify(input));
    }
});

test('sameRepo treats a case difference as the same repository, because GitHub does', () => {
    // Requesting Microsoft/typescript answers as microsoft/TypeScript. Calling that
    // a move would flag a large share of every real dependency list.
    assert.equal(sameRepo('Microsoft/typescript', 'microsoft/TypeScript'), true);
    assert.equal(sameRepo('facebook/create-react-app', 'react/create-react-app'), false);
});

// ---------------------------------------------------------------------------
// Licences
// ---------------------------------------------------------------------------

test('normalizeLicense resolves the forms that carry meaning', () => {
    assert.deepEqual(normalizeLicense('MIT').ids, ['MIT']);
    assert.deepEqual(normalizeLicense('(MIT OR Apache-2.0)').ids, ['MIT', 'APACHE-2.0']);
    assert.deepEqual(normalizeLicense('Apache-2.0 WITH LLVM-exception').ids, ['APACHE-2.0']);
    assert.deepEqual(normalizeLicense({ type: 'ISC', url: 'x' }).ids, ['ISC']);
    assert.deepEqual(normalizeLicense([{ type: 'MIT' }, { type: 'GPL-3.0' }]).ids, ['MIT', 'GPL-3.0']);
    assert.deepEqual(normalizeLicense('GPL-3.0-or-later').ids, ['GPL-3.0']);
});

test('normalizeLicense refuses to resolve text that says nothing', () => {
    for (const value of ['', null, undefined, 'SEE LICENSE IN LICENSE', 'UNLICENSED', 'NOASSERTION', 'Proprietary', 'unknown']) {
        assert.equal(normalizeLicense(value).resolved, false, JSON.stringify(value));
    }
});

test('licensesCompatible lets a family wildcard cover a specific version', () => {
    assert.equal(licensesCompatible('APACHE-*', 'APACHE-2.0'), true);
    assert.equal(licensesCompatible('BSD-*', 'BSD-3-CLAUSE'), true);
    assert.equal(licensesCompatible('APACHE-2.0', 'MIT'), false);
    assert.equal(licensesCompatible('GPL-2.0', 'GPL-3.0'), false);
});

test('licenseVerdict stays null unless both sides resolved', () => {
    assert.equal(licenseVerdict('MIT', 'MIT'), 'match');
    assert.equal(licenseVerdict('(MIT OR Apache-2.0)', 'Apache-2.0'), 'match');
    assert.equal(licenseVerdict('MIT', 'BUSL-1.1'), 'mismatch');
    // The expensive false positive this exists to prevent.
    assert.equal(licenseVerdict('SEE LICENSE IN LICENSE.md', 'MIT'), null);
    assert.equal(licenseVerdict('MIT', null), null);
    assert.equal(licenseVerdict('GNU LGPL', 'LGPL-2.1'), 'match');
});

test('verdictFromIds compares resolved identifiers, which is what PyPI leaves us with', () => {
    // The defect this exists to prevent: PyPI's licence often only resolves through
    // its classifiers, into a family wildcard. Rendering that back into a string and
    // re-parsing it produced "no answer" for every Apache-licensed Python package.
    assert.equal(verdictFromIds(['APACHE-*'], ['APACHE-2.0']), 'match');
    assert.equal(verdictFromIds(['LGPL-*'], ['LGPL-2.1']), 'match');
    assert.equal(verdictFromIds(['MIT'], ['APACHE-2.0']), 'mismatch');
    assert.equal(verdictFromIds([], ['MIT']), null);
    assert.equal(verdictFromIds(['MIT'], []), null);
    assert.equal(normalizeLicense('APACHE-*').resolved, false, 'the wildcard is an internal token, not something to re-parse');
});

test('licenseFromClassifiers reads what PyPI actually publishes', () => {
    assert.deepEqual(licenseFromClassifiers(['License :: OSI Approved :: MIT License']), ['MIT']);
    assert.deepEqual(licenseFromClassifiers(['License :: OSI Approved :: Apache Software License']), ['APACHE-*']);
    assert.deepEqual(
        licenseFromClassifiers(['License :: OSI Approved :: GNU Library or Lesser General Public License (LGPL)']),
        ['LGPL-*'],
    );
    assert.deepEqual(licenseFromClassifiers(['Programming Language :: Python :: 3']), []);
    assert.deepEqual(licenseFromClassifiers(['License :: OSI Approved']), []);
});

// ---------------------------------------------------------------------------
// Manifests
// ---------------------------------------------------------------------------

test('detectManifestType recognises each supported file from its contents', () => {
    assert.equal(detectManifestType('', '{"name":"x","dependencies":{"a":"^1.0.0"}}'), 'package.json');
    assert.equal(detectManifestType('', 'module example.com/x\n\ngo 1.21\n\nrequire github.com/a/b v1.0.0\n'), 'go.mod');
    assert.equal(detectManifestType('', 'requests==2.31.0\nflask>=2\n'), 'requirements.txt');
    assert.equal(detectManifestType('https://x/y/package.json', 'anything'), 'package.json');
    assert.equal(detectManifestType('', 'hello world'), null);
});

test('parseManifest reads the requested package.json blocks and skips local links', () => {
    const text = JSON.stringify({
        dependencies: { express: '^4.18.0', 'my-local': 'file:../local', internal: 'workspace:*' },
        devDependencies: { jest: '29.0.0' },
    });
    const deps = parseManifest(text, 'package.json', ['dependencies']);
    assert.deepEqual(deps.entries.map((e) => e.name), ['express']);
    const both = parseManifest(text, 'package.json', ['dependencies', 'devDependencies']);
    assert.deepEqual(both.entries.map((e) => e.name), ['express', 'jest']);
    assert.equal(both.entries[1].group, 'devDependencies');
});

test('parseManifest sends a git-hosted dependency straight to the repository', () => {
    const text = JSON.stringify({ dependencies: { forked: 'github:someone/forked-lib' } });
    const { entries } = parseManifest(text, 'package.json', ['dependencies']);
    assert.equal(entries[0].registry, null, 'no registry record exists for a git dependency');
    assert.equal(entries[0].repoRef, 'someone/forked-lib');
});

test('parseManifest handles the awkward corners of requirements.txt', () => {
    const text = [
        '# a comment',
        '-r base.txt',
        '--index-url https://example.invalid/simple',
        'requests==2.31.0',
        'Django>=4.2,<5  # trailing comment',
        'uvicorn[standard]==0.30.0',
        'pywin32==306 ; sys_platform == "win32"',
        'https://example.invalid/pkg.whl',
        'mylib @ https://github.com/me/mylib/archive/main.zip',
        'requests>=2',
    ].join('\n');
    const { entries } = parseManifest(text, 'requirements.txt');
    assert.deepEqual(entries.map((e) => e.name), ['requests', 'Django', 'uvicorn', 'pywin32', 'mylib']);
    assert.equal(entries[0].spec, '==2.31.0');
    assert.equal(entries[2].spec, '==0.30.0', 'the extras marker is not part of the version');
    assert.equal(entries[3].spec, '==306', 'an environment marker is not part of the version');
    assert.equal(entries[4].registry, null, 'a direct URL requirement has no registry record');
    assert.equal(entries[4].repoRef, 'me/mylib');
});

test('parseManifest reads go.mod requires and drops the major-version suffix', () => {
    const text = [
        'module example.com/mine',
        'go 1.22',
        'require github.com/spf13/cobra v1.8.0',
        'require (',
        '    github.com/stretchr/testify v1.9.0',
        '    github.com/go-chi/chi/v5 v5.0.12',
        '    golang.org/x/net v0.24.0 // indirect',
        '    github.com/lib/pq v1.10.9 // indirect',
        ')',
    ].join('\n');
    const { entries } = parseManifest(text, 'go.mod');
    assert.deepEqual(entries.map((e) => e.repoRef), [
        'spf13/cobra',
        'stretchr/testify',
        'go-chi/chi',
        'lib/pq',
    ], 'non-GitHub modules are left out and /v5 is not a repository name');
    assert.equal(entries[3].group, 'indirect');
});

test('parseManifest counts the go modules it had to leave out', () => {
    // Quietly shrinking someone's dependency list reads as "all clear".
    const text = [
        'module example.com/mine',
        'require (',
        '    github.com/spf13/cobra v1.8.0',
        '    golang.org/x/net v0.24.0 // indirect',
        '    gopkg.in/yaml.v3 v3.0.1',
        ')',
    ].join('\n');
    const parsed = parseManifest(text, 'go.mod');
    assert.equal(parsed.entries.length, 1);
    assert.equal(parsed.skippedOffGithub, 2);
    const { notes } = targetsFromManifest(text, 'go.mod');
    assert.ok(notes.some((n) => /2 module\(s\).*not hosted on GitHub/.test(n)), JSON.stringify(notes));
});

test('parseManifest refuses a manifest type it cannot parse properly', () => {
    assert.throws(() => parseManifest('[project]', 'pyproject.toml'), /Unsupported manifest type/);
});

test('parsePackageRef understands registry prefixes', () => {
    assert.deepEqual(parsePackageRef('npm:express', 'pypi'), { registry: 'npm', name: 'express' });
    assert.deepEqual(parsePackageRef('pypi:requests', 'npm'), { registry: 'pypi', name: 'requests' });
    assert.deepEqual(parsePackageRef('pip:requests', 'npm'), { registry: 'pypi', name: 'requests' });
    assert.deepEqual(parsePackageRef('@babel/core', 'npm'), { registry: 'npm', name: '@babel/core' });
    assert.deepEqual(parsePackageRef('flask', 'pypi'), { registry: 'pypi', name: 'flask' });
});

test('pinnedVersion tells an exact version from a range', () => {
    assert.equal(pinnedVersion('1.2.3', 'npm'), '1.2.3');
    assert.equal(pinnedVersion('^1.2.3', 'npm'), null);
    assert.equal(pinnedVersion('~1.2', 'npm'), null);
    assert.equal(pinnedVersion('==2.31.0', 'pypi'), '2.31.0');
    assert.equal(pinnedVersion('==2.31.*', 'pypi'), null);
    assert.equal(pinnedVersion('>=2', 'pypi'), null);
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

function headers(map) {
    return { get: (k) => (k.toLowerCase() in map ? String(map[k.toLowerCase()]) : null) };
}

test('retryAfterMs reads both spellings of Retry-After', () => {
    assert.equal(retryAfterMs(headers({ 'retry-after': '30' })), 30000);
    const soon = new Date(Date.now() + 20000).toUTCString();
    const ms = retryAfterMs(headers({ 'retry-after': soon }));
    assert.ok(ms > 10000 && ms <= 21000, `expected about 20 s, got ${ms}`);
    assert.equal(retryAfterMs(headers({})), null);
});

test('isQuotaExhausted separates a spent allowance from an ordinary refusal', () => {
    assert.equal(isQuotaExhausted(403, headers({ 'x-ratelimit-remaining': '0' })), true);
    assert.equal(isQuotaExhausted(429, headers({ 'x-ratelimit-remaining': '0' })), true);
    // A 403 with allowance left is a private repository or a blocked agent, and
    // reporting it as a rate limit would send the user to fix the wrong thing.
    assert.equal(isQuotaExhausted(403, headers({ 'x-ratelimit-remaining': '42' })), false);
    assert.equal(isQuotaExhausted(403, headers({})), false);
    assert.equal(isQuotaExhausted(404, headers({ 'x-ratelimit-remaining': '0' })), false);
});

test('an exhausted allowance outranks an allowed status', async () => {
    // The contributor endpoint answers 403 for "this list is too big to compute",
    // so 403 is on its allow-list. An exhausted quota arrives as 403 too, and if
    // the allow-list won it would be reported as a missing contributor list
    // instead of a spent allowance - sending the user to fix the wrong thing.
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response('{"message":"rate limit"}', {
        status: 403,
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-limit': '60', 'x-ratelimit-reset': '1700000000' },
    });
    try {
        await assert.rejects(
            () => fetchJson('https://api.github.com/repos/a/b/contributors', { allowStatuses: [204, 403, 404], retries: 0 }),
            (err) => err.name === 'RateLimitError' && err.limit === 60,
        );
    } finally {
        globalThis.fetch = original;
    }
});

test('a 403 with allowance left is still an ordinary answer', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response('[]', {
        status: 403,
        headers: { 'x-ratelimit-remaining': '55', 'content-type': 'application/json' },
    });
    try {
        const { status } = await fetchJson('https://api.github.com/repos/a/b/contributors', { allowStatuses: [403], retries: 0 });
        assert.equal(status, 403);
    } finally {
        globalThis.fetch = original;
    }
});

test('readRateLimit turns the reset epoch into a readable time', () => {
    const rl = readRateLimit(headers({ 'x-ratelimit-remaining': '7', 'x-ratelimit-limit': '60', 'x-ratelimit-reset': '1700000000' }));
    assert.equal(rl.remaining, 7);
    assert.equal(rl.limit, 60);
    assert.equal(rl.resetAt, new Date(1700000000000).toISOString());
});

test('daysBetween is null for a missing or unreadable date', () => {
    const now = Date.parse('2026-01-11T00:00:00Z');
    assert.equal(daysBetween('2026-01-01T00:00:00Z', now), 10);
    assert.equal(daysBetween(null, now), null);
    assert.equal(daysBetween('not a date', now), null);
});

// ---------------------------------------------------------------------------
// The audit rules
// ---------------------------------------------------------------------------

const NOW = Date.parse('2026-07-31T00:00:00Z');

function repoRecord(over = {}) {
    return {
        requestedRepo: 'owner/name',
        exists: true,
        resolvedRepo: 'owner/name',
        moved: false,
        moveKind: null,
        archived: false,
        disabled: false,
        isFork: false,
        parentRepo: null,
        parentPushedAt: null,
        pushedAt: new Date(NOW - 5 * 86400000).toISOString(),
        daysSinceLastPush: 5,
        stars: 100,
        forks: 5,
        openIssues: 2,
        hasIssuesEnabled: true,
        repoLicenseSpdx: 'MIT',
        repoLicenseName: 'MIT License',
        repoLicenseNonStandard: false,
        repoHasNoLicenseFile: false,
        htmlUrl: 'https://github.com/owner/name',
        ...over,
    };
}

function pkgRecord(over = {}) {
    return {
        registry: 'npm',
        name: 'thing',
        found: true,
        version: '1.0.0',
        resolvedFrom: 'latest',
        declaredLicense: 'MIT',
        declaredLicenseIds: ['MIT'],
        deprecated: false,
        deprecationMessage: null,
        yanked: null,
        repoUrl: 'git+https://github.com/owner/name.git',
        repoDirectory: null,
        knownVulnerabilities: null,
        ...over,
    };
}

test('the headline finding needs both halves: registry silent AND repository archived', () => {
    const silent = auditOne({}, pkgRecord(), repoRecord({ archived: true }));
    assert.equal(silent.silentAbandonment, true);
    assert.ok(silent.issueCodes.includes('silent_abandonment'));
    assert.equal(silent.riskLevel, 'critical');
});

test('an archived repository the registry already deprecated is not a silent abandonment', () => {
    const announced = auditOne({}, pkgRecord({ deprecated: true, deprecationMessage: 'use x instead' }), repoRecord({ archived: true }));
    assert.equal(announced.silentAbandonment, false);
    assert.ok(!announced.issueCodes.includes('silent_abandonment'));
    assert.ok(announced.issueCodes.includes('deprecated_on_registry'));
    assert.ok(announced.issueCodes.includes('repo_archived'));
});

test('staleness alone never becomes the headline finding', () => {
    // "No commit for a year" is my inference; "archived" is the maintainer's own
    // declaration. Only the second is strong enough to call abandonment.
    const stale = auditOne({}, pkgRecord(), repoRecord({ daysSinceLastPush: 900 }), { staleAfterDays: 365 });
    assert.ok(stale.issueCodes.includes('stale_no_push'));
    assert.ok(!stale.issueCodes.includes('silent_abandonment'));
    assert.equal(stale.silentAbandonment, false);
    assert.equal(stale.riskLevel, 'medium');
});

test('an archived repository is not also reported as stale', () => {
    const row = auditOne({}, pkgRecord(), repoRecord({ archived: true, daysSinceLastPush: 900 }));
    assert.ok(row.issueCodes.includes('repo_archived'));
    assert.ok(!row.issueCodes.includes('stale_no_push'), 'one fact should not produce two findings');
});

test('a silent move is reported, a case difference is not', () => {
    const moved = auditOne({}, pkgRecord(), repoRecord({ moved: true, moveKind: 'transferred', resolvedRepo: 'newowner/name' }));
    assert.ok(moved.issueCodes.includes('repo_moved'));
    assert.equal(moved.resolvedRepo, 'newowner/name');
    const same = auditOne({}, pkgRecord(), repoRecord());
    assert.ok(!same.issueCodes.includes('repo_moved'));
});

test('a licence change is reported only when both sides are known', () => {
    const changed = auditOne({}, pkgRecord({ declaredLicense: 'MIT', declaredLicenseIds: ['MIT'] }),
        repoRecord({ repoLicenseSpdx: 'AGPL-3.0', repoLicenseName: 'GNU AGPLv3' }));
    assert.ok(changed.issueCodes.includes('license_mismatch'));
    assert.equal(changed.licenseMatch, false);

    const unknowable = auditOne({}, pkgRecord({ declaredLicense: 'SEE LICENSE IN LICENSE', declaredLicenseIds: [] }),
        repoRecord({ repoLicenseSpdx: 'MIT' }));
    assert.equal(unknowable.licenseMatch, null);
    assert.ok(!unknowable.issueCodes.includes('license_mismatch'));
});

test('a repository GitHub cannot classify is flagged, and a source-available one is named', () => {
    const nonStandard = auditOne({}, pkgRecord(), repoRecord({ repoLicenseSpdx: null, repoLicenseName: 'Other', repoLicenseNonStandard: true }));
    assert.ok(nonStandard.issueCodes.includes('license_needs_review'));
    assert.equal(nonStandard.riskLevel, 'low', 'lodash and jQuery UI both land here; it must not outrank a real problem');
    assert.equal(nonStandard.licenseMatch, null, 'an unclassifiable licence cannot be compared');

    const busl = auditOne({}, pkgRecord({ declaredLicense: 'BUSL-1.1', declaredLicenseIds: ['BUSL-1.1'] }),
        repoRecord({ repoLicenseSpdx: 'BUSL-1.1', repoLicenseName: 'Business Source License 1.1' }));
    assert.ok(busl.issueCodes.includes('license_now_source_available'));
});

test('a missing repository is reported without claiming to know why', () => {
    const gone = auditOne({}, pkgRecord(), {
        requestedRepo: 'owner/name',
        exists: false,
        httpStatus: 404,
        notFoundReason: 'deleted, renamed away, or private',
        resolvedRepo: null,
        moved: null,
    });
    assert.ok(gone.issueCodes.includes('repo_gone'));
    assert.match(gone.issues.find((i) => i.code === 'repo_gone').detail, /deleted, renamed away, or private/);
    assert.equal(gone.silentAbandonment, null, 'nothing can be concluded about abandonment from a 404');
});

test('a fork whose upstream is newer is flagged, and one that is ahead is not', () => {
    const behind = auditOne({}, pkgRecord(), repoRecord({
        isFork: true,
        parentRepo: 'upstream/name',
        parentPushedAt: new Date(NOW - 1 * 86400000).toISOString(),
        pushedAt: new Date(NOW - 400 * 86400000).toISOString(),
        daysSinceLastPush: 400,
    }));
    assert.ok(behind.issueCodes.includes('fork_behind_upstream'));

    const ahead = auditOne({}, pkgRecord(), repoRecord({
        isFork: true,
        parentRepo: 'upstream/name',
        parentPushedAt: new Date(NOW - 400 * 86400000).toISOString(),
    }));
    assert.ok(!ahead.issueCodes.includes('fork_behind_upstream'));
});

test('a healthy dependency produces no findings at all', () => {
    const clean = auditOne({}, pkgRecord(), repoRecord());
    assert.deepEqual(clean.issueCodes, [], JSON.stringify(clean.issues));
    assert.equal(clean.riskLevel, 'ok');
    assert.equal(clean.licenseMatch, true);
    assert.equal(clean.silentAbandonment, false);
});

test('a repository with no registry behind it is judged on repository facts only', () => {
    const row = auditOne({ requestedRepo: 'owner/name' }, null, repoRecord({ archived: true }));
    assert.ok(row.issueCodes.includes('repo_archived'));
    assert.equal(row.silentAbandonment, null, 'with no registry record there is nothing to be silent');
    assert.equal(row.licenseMatch, null);
});

test('severity ordering puts the strongest finding on the row', () => {
    assert.equal(severityOf('silent_abandonment'), 'critical');
    assert.equal(severityOf('repo_moved'), 'medium');
    assert.equal(severityOf('license_needs_review'), 'low');
    assert.equal(severityOf('issues_disabled'), 'low');
    assert.equal(severityOf('something_unknown'), 'low');
});

test('actionList ranks by severity and leaves the clean rows out', () => {
    const rows = [
        auditOne({ requestedRepo: 'a/a' }, pkgRecord({ name: 'a' }), repoRecord({ stars: 10 })),
        auditOne({ requestedRepo: 'b/b' }, pkgRecord({ name: 'b' }), repoRecord({ hasIssuesEnabled: false, stars: 20 })),
        auditOne({ requestedRepo: 'c/c' }, pkgRecord({ name: 'c' }), repoRecord({ archived: true, stars: 30 })),
        auditOne({ requestedRepo: 'd/d' }, pkgRecord({ name: 'd' }), repoRecord({ moved: true, moveKind: 'renamed', stars: 40 })),
    ];
    const list = actionList(rows);
    assert.deepEqual(list.map((r) => r.target), ['c', 'd', 'b']);
    assert.equal(list[0].riskLevel, 'critical');
});

test('actionList says where every entry came from, even when the answer sorts last', () => {
    // The failure this guards against: the caller asked about one repository, three
    // packages arrived from somewhere else, and the list is ranked by severity. So the
    // entry that answers the question ends up under three entries nobody named. Without
    // input and source there is no way to tell which is which.
    const rows = [
        auditOne(
            { source: 'repos', input: 'facebook/create-react-app', requestedRepo: 'facebook/create-react-app' },
            null,
            repoRecord({ moved: true, moveKind: 'transferred', stars: 100 }),
        ),
        auditOne(
            { source: 'packages', input: 'npm:babel-eslint', requestedRepo: 'babel/babel-eslint', packageName: 'babel-eslint', registry: 'npm' },
            pkgRecord({ name: 'babel-eslint' }),
            repoRecord({ archived: true, stars: 10 }),
        ),
    ];
    const list = actionList(rows);
    assert.equal(list[0].source, 'packages', 'severity still decides the order');
    assert.equal(list.at(-1).input, 'facebook/create-react-app', 'the asked-for row really does sort last');
    assert.ok(list.every((e) => e.input && e.source), 'every entry can be attributed regardless of order');
});

test('summarize breaks the counts down by where each row came from', () => {
    const rows = [
        auditOne(
            { source: 'repos', input: 'facebook/create-react-app', requestedRepo: 'facebook/create-react-app' },
            null,
            repoRecord({ moved: true, moveKind: 'transferred' }),
        ),
        auditOne(
            { source: 'packages', input: 'npm:babel-eslint', requestedRepo: 'babel/babel-eslint', packageName: 'babel-eslint' },
            pkgRecord({ name: 'babel-eslint' }),
            repoRecord({ archived: true }),
        ),
        auditOne(
            { source: 'packages', input: 'npm:left-pad', requestedRepo: 'left-pad/left-pad', packageName: 'left-pad' },
            pkgRecord({ name: 'left-pad' }),
            repoRecord({ archived: true }),
        ),
    ];
    const stats = summarize(rows);
    // The flat count says "2 critical" to someone who asked about one repository.
    assert.equal(stats.byRiskLevel.critical, 2);
    // The breakdown says whose.
    assert.equal(stats.bySource.repos.checked, 1);
    assert.equal(stats.bySource.repos.critical, 0);
    assert.equal(stats.bySource.packages.checked, 2);
    assert.equal(stats.bySource.packages.critical, 2);
    // The parts add up to the whole, so neither number can be quietly wrong.
    const totals = Object.values(stats.bySource).reduce((n, g) => n + g.checked, 0);
    assert.equal(totals, stats.checked);
});

test('summarize with a single source reports one group that matches the flat totals', () => {
    // Negative control: the breakdown must not invent structure when there is none.
    const rows = [
        auditOne({ source: 'repos', input: 'a/a', requestedRepo: 'a/a' }, null, repoRecord({ archived: true })),
        auditOne({ source: 'repos', input: 'b/b', requestedRepo: 'b/b' }, null, repoRecord()),
    ];
    const stats = summarize(rows);
    assert.deepEqual(Object.keys(stats.bySource), ['repos']);
    assert.equal(stats.bySource.repos.checked, stats.checked);
    assert.equal(stats.bySource.repos.critical, stats.byRiskLevel.critical);
});

test('licenseReport counts what is installed and names what could not be resolved', () => {
    const rows = [
        auditOne({}, pkgRecord({ name: 'a' }), repoRecord({ repoLicenseSpdx: 'MIT' })),
        auditOne({}, pkgRecord({ name: 'b' }), repoRecord({ repoLicenseSpdx: 'MIT' })),
        auditOne({}, pkgRecord({ name: 'c', declaredLicense: 'BUSL-1.1', declaredLicenseIds: ['BUSL-1.1'] }),
            repoRecord({ repoLicenseSpdx: 'BUSL-1.1' })),
        auditOne({}, pkgRecord({ name: 'd', declaredLicense: null, declaredLicenseIds: [] }),
            repoRecord({ repoLicenseSpdx: null, repoLicenseName: 'Other', repoLicenseNonStandard: true })),
    ];
    const report = licenseReport(rows);
    assert.deepEqual(report.byLicense[0], { license: 'MIT', count: 2, sourceAvailable: false });
    assert.equal(report.byLicense.find((l) => l.license === 'BUSL-1.1').sourceAvailable, true);
    assert.deepEqual(report.unresolved.map((u) => u.target), ['d']);
});

test('licenseReport says which unresolved licences the caller actually asked about', () => {
    // This list sends a person to open licence files by hand. Sending them to read one
    // for a dependency they never named wastes the same time a false finding does.
    const rows = [
        auditOne(
            { source: 'repos', input: 'owner/mine', requestedRepo: 'owner/mine' },
            pkgRecord({ name: null, declaredLicense: null, declaredLicenseIds: [] }),
            repoRecord({ repoLicenseSpdx: null, repoLicenseName: 'Other', repoLicenseNonStandard: true }),
        ),
        auditOne(
            { source: 'packages', input: 'npm:theirs', requestedRepo: 'them/theirs', packageName: 'theirs' },
            pkgRecord({ name: 'theirs', declaredLicense: null, declaredLicenseIds: [] }),
            repoRecord({ repoLicenseSpdx: null, repoLicenseName: 'Other', repoLicenseNonStandard: true }),
        ),
    ];
    const report = licenseReport(rows);
    assert.equal(report.unresolvedCount, 2);
    assert.deepEqual(report.unresolved.map((u) => u.source), ['repos', 'packages']);
    assert.ok(report.unresolved.every((u) => u.input), 'every entry names the input it came from');
});

test('licenseReport leaves out repositories that are not there', () => {
    // "Go and read this licence file" is useless advice about a 404.
    const rows = [
        auditOne({}, pkgRecord({ name: 'alive' }), repoRecord({ repoLicenseSpdx: 'MIT' })),
        auditOne({ requestedRepo: 'gone/gone' }, null, { requestedRepo: 'gone/gone', exists: false, httpStatus: 404, notFoundReason: 'x', resolvedRepo: null, moved: null }),
    ];
    const report = licenseReport(rows);
    assert.deepEqual(report.unresolved, []);
    assert.equal(report.unresolvedCount, 0);
    assert.deepEqual(report.byLicense, [{ license: 'MIT', count: 1, sourceAvailable: false }]);
});

test('summarize reports a rate of null rather than zero when nothing was comparable', () => {
    const rows = [auditOne({ requestedRepo: 'a/a' }, null, repoRecord())];
    const stats = summarize(rows);
    assert.equal(stats.licenseComparison.comparable, 0);
    assert.equal(stats.licenseComparison.mismatchRate, null, '"nothing compared" is not "nothing mismatched"');
    assert.equal(stats.checked, 1);
});

// ---------------------------------------------------------------------------
// Building the work list
// ---------------------------------------------------------------------------

test('targetsFromRepos keeps a note for every entry it had to skip', () => {
    const { targets, notes } = targetsFromRepos(['owner/name', 'https://gitlab.com/a/b', 'nonsense']);
    assert.equal(targets.length, 1);
    assert.equal(notes.length, 2);
});

test('buildTargets removes duplicates so one repository is not fetched twice', async () => {
    const { targets, notes } = await buildTargets({
        repos: ['owner/name', 'https://github.com/Owner/Name.git'],
        packages: ['npm:express', 'express'],
        defaultRegistry: 'npm',
    });
    assert.equal(targets.length, 2, JSON.stringify(targets.map((t) => t.input)));
    assert.ok(notes.some((n) => /Removed 2 duplicate/.test(n)));
});

test('buildTargets reads a manifest and reports how many entries it found', async () => {
    const { targets, notes } = await buildTargets({
        manifestText: JSON.stringify({ dependencies: { express: '^4.0.0', lodash: '4.17.21' } }),
        manifestType: 'package.json',
        manifestGroups: ['dependencies'],
    });
    assert.deepEqual(targets.map((t) => t.packageName), ['express', 'lodash']);
    assert.equal(targets[1].spec, '4.17.21');
    assert.ok(notes.some((n) => /Read 2 dependency entries/.test(n)));
});

// ---------------------------------------------------------------------------
// The crash guard
// ---------------------------------------------------------------------------

function assertionError(message, stack) {
    const err = new Error(message);
    err.code = 'ERR_ASSERTION';
    err.stack = `AssertionError [ERR_ASSERTION]: ${message}\n${stack}`;
    return err;
}

test('the crash guard recognises the one assertion it is allowed to swallow', () => {
    const fromClient = assertionError(
        'The expression evaluated to a falsy value:\n\n  assert(!this.paused)\n',
        '    at Parser.finish (node:internal/deps/undici/undici:6789:12)',
    );
    assert.equal(isUndiciParserAssertion(fromClient), true);
});

test('the crash guard does not swallow an assertion from my own code', () => {
    // A guard that hides real defects would be worse than the crash it prevents.
    const sameWordsMine = assertionError(
        'The expression evaluated to a falsy value:\n\n  assert(!this.paused)\n',
        '    at auditOne (file:///app/src/audit.js:120:5)',
    );
    assert.equal(isUndiciParserAssertion(sameWordsMine), false, 'the undici frame is what makes it the client\'s');

    const otherAssertion = assertionError(
        'Expected values to be strictly equal',
        '    at Parser.finish (node:internal/deps/undici/undici:6789:12)',
    );
    assert.equal(isUndiciParserAssertion(otherAssertion), false);

    const notAnAssertion = new Error('assert(!this.paused) undici');
    assert.equal(isUndiciParserAssertion(notAnAssertion), false);
    assert.equal(isUndiciParserAssertion(null), false);
});

test('installHttpCrashGuard hands back a counter of what it swallowed', () => {
    const messages = [];
    const before = process.listenerCount('uncaughtException');
    const swallowed = installHttpCrashGuard({ warning: (m) => messages.push(m) });
    try {
        assert.equal(process.listenerCount('uncaughtException'), before + 1);
        assert.equal(typeof swallowed, 'function');
        assert.equal(swallowed(), 0);
    } finally {
        const listeners = process.listeners('uncaughtException');
        process.off('uncaughtException', listeners[listeners.length - 1]);
    }
});
