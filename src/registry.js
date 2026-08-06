/**
 * What the package registry says about a dependency.
 *
 * This is the "declared" half of every finding: the licence you agreed to when
 * you installed the package, and whether the registry admits the package is
 * deprecated. The other half comes from GitHub. A finding only exists where the
 * two disagree.
 *
 * Both registries are read through their documented JSON APIs with no key and
 * no scraping. Where a version is pinned in the manifest, the pinned version is
 * read rather than the newest one - partly because it is what you actually
 * depend on, and partly because the per-version document is a few kilobytes
 * while the whole-project document can be megabytes (boto3's is 3 MB).
 */

import { fetchJson } from './http.js';
import { licenseFromClassifiers, normalizeLicense, parseRepoRef } from './parse.js';

const GITHUB_URL = /github\.com[/:]([^/\s#?]+)\/([^/\s#?]+)/i;

/** An exact version, as opposed to a range like "^1.2.0" or ">=2,<3". */
export function pinnedVersion(spec, registry) {
    const s = String(spec ?? '').trim();
    if (!s) return null;
    if (registry === 'npm') {
        return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(s) ? s : null;
    }
    const m = s.match(/^==\s*([0-9][0-9A-Za-z.!+-]*)$/);
    if (!m) return null;
    // "==1.2.*" is a range wearing an equals sign.
    return m[1].includes('*') ? null : m[1];
}

function pickRepoUrl(candidates) {
    for (const value of candidates) {
        if (!value) continue;
        const text = String(value);
        if (GITHUB_URL.test(text)) return text;
    }
    return null;
}

async function fetchNpm(name, spec, options) {
    const encoded = name.startsWith('@')
        ? `@${encodeURIComponent(name.slice(1)).replace(/%2F/gi, '/').split('/').map(encodeURIComponent).join('%2F')}`
        : encodeURIComponent(name);
    const pinned = pinnedVersion(spec, 'npm');
    const url = `https://registry.npmjs.org/${encoded}/${pinned ?? 'latest'}`;
    const { status, json } = await fetchJson(url, { ...options, allowStatuses: [404] });
    if (status === 404 || !json) {
        return { registry: 'npm', name, found: false, httpStatus: status, error: 'not on the npm registry' };
    }

    const repository = json.repository ?? null;
    const repoUrl = pickRepoUrl([
        typeof repository === 'string' ? repository : repository?.url,
        json.homepage,
        json.bugs?.url,
    ]);
    const license = normalizeLicense(json.license ?? json.licenses ?? null);

    return {
        registry: 'npm',
        name,
        found: true,
        httpStatus: status,
        version: json.version ?? null,
        resolvedFrom: pinned ? 'pinned' : 'latest',
        declaredLicense: license.raw,
        declaredLicenseIds: license.ids,
        declaredLicenseSource: license.resolved ? 'license' : (license.raw ? 'license (unresolved)' : null),
        deprecated: Boolean(json.deprecated),
        deprecationMessage: json.deprecated ? String(json.deprecated).slice(0, 300) : null,
        yanked: null,
        yankedReason: null,
        repoUrl,
        repoDirectory: (repository && typeof repository === 'object' && repository.directory) || null,
        homepage: json.homepage ?? null,
        knownVulnerabilities: null,
    };
}

async function fetchPypi(name, spec, options) {
    const pinned = pinnedVersion(spec, 'pypi');
    const url = pinned
        ? `https://pypi.org/pypi/${encodeURIComponent(name)}/${encodeURIComponent(pinned)}/json`
        : `https://pypi.org/pypi/${encodeURIComponent(name)}/json`;
    const { status, json } = await fetchJson(url, { ...options, allowStatuses: [404] });
    if (status === 404 || !json?.info) {
        return { registry: 'pypi', name, found: false, httpStatus: status, error: 'not on PyPI' };
    }

    const info = json.info;
    // PEP 639 puts an SPDX expression in license_expression; the classifiers are
    // the next most reliable source; the free-text `license` field is last because
    // it holds things like "GNU LGPL" and "" that resolve to nothing.
    let license = normalizeLicense(info.license_expression ?? null);
    let licenseSource = license.resolved ? 'license_expression' : null;
    if (!license.resolved) {
        const fromClassifiers = licenseFromClassifiers(info.classifiers);
        if (fromClassifiers.length) {
            // The identifiers are what gets compared; the readable classifier text is
            // what gets shown, so the row does not report a licence called "APACHE-*".
            const readable = (info.classifiers ?? [])
                .filter((c) => /^License\s*::/i.test(String(c)))
                .map((c) => String(c).replace(/^License\s*::\s*(?:OSI Approved\s*::\s*)?/i, ''))
                .filter((c) => c && !/^OSI Approved$/i.test(c));
            license = { ids: fromClassifiers, raw: (readable.join(' OR ') || fromClassifiers.join(' OR ')).slice(0, 120), resolved: true };
            licenseSource = 'classifiers';
        }
    }
    if (!license.resolved) {
        license = normalizeLicense(info.license ?? null);
        if (license.resolved) licenseSource = 'license';
    }
    if (!licenseSource && info.license) {
        // Unresolvable, but worth showing the reader what the project actually wrote.
        license = { ids: [], raw: String(info.license).slice(0, 120), resolved: false };
        licenseSource = 'license (unresolved)';
    }

    const projectUrls = info.project_urls ?? {};
    const ordered = Object.entries(projectUrls)
        .sort(([a], [b]) => {
            const rank = (k) => (/source|repo|code|github/i.test(k) ? 0 : 1);
            return rank(a) - rank(b);
        })
        .map(([, v]) => v);
    const repoUrl = pickRepoUrl([...ordered, info.home_page, info.package_url]);

    const files = Array.isArray(json.urls) ? json.urls : [];
    const yanked = info.yanked ?? (files.length ? files.every((f) => f.yanked === true) : null);

    return {
        registry: 'pypi',
        name,
        found: true,
        httpStatus: status,
        version: info.version ?? null,
        resolvedFrom: pinned ? 'pinned' : 'latest',
        declaredLicense: license.raw,
        declaredLicenseIds: license.ids,
        declaredLicenseSource: licenseSource,
        // PyPI has no deprecation flag at all, so this is `null` (unknown) rather
        // than `false` (checked and healthy). Reporting it as false would claim a
        // check that PyPI does not support.
        deprecated: null,
        deprecationMessage: null,
        yanked: yanked === true ? true : (yanked === false ? false : null),
        yankedReason: info.yanked_reason ?? null,
        repoUrl,
        repoDirectory: null,
        homepage: info.home_page ?? null,
        knownVulnerabilities: Array.isArray(json.vulnerabilities) ? json.vulnerabilities.length : null,
    };
}

/**
 * @param {'npm'|'pypi'} registry
 * @param {string} name
 * @param {string} [spec] the version range as written in the manifest
 */
export async function lookupPackage(registry, name, spec, options = {}) {
    try {
        if (registry === 'npm') return await fetchNpm(name, spec, options);
        if (registry === 'pypi') return await fetchPypi(name, spec, options);
        return { registry, name, found: false, httpStatus: null, error: `unknown registry "${registry}"` };
    } catch (err) {
        return {
            registry,
            name,
            found: false,
            httpStatus: null,
            error: String(err?.message || err).slice(0, 200),
        };
    }
}

/** The repository a registry record points at, if it points at GitHub at all. */
export function repoFromRegistry(record) {
    if (!record?.repoUrl) return null;
    const parsed = parseRepoRef(record.repoUrl);
    return parsed.ok ? parsed : null;
}
