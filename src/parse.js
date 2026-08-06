/**
 * Turning messy human input into two clean things: a repository coordinate and
 * a licence that can actually be compared.
 *
 * Both are places where a careless implementation invents findings. A
 * repository reference arrives in a dozen shapes (`git+ssh://`, `github:`,
 * a tree URL deep inside a monorepo) and a licence arrives as free text that
 * often means nothing at all ("SEE LICENSE IN LICENSE", "GNU LGPL", ""). The
 * rule throughout is that an unresolved value stays `null` and produces no
 * finding, because a false "your licence changed" is worse than a silent one.
 */

const NAME_CHARS = /^[A-Za-z0-9._-]+$/;
const OWNER_CHARS = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;

/**
 * @param {string} raw anything that might name a GitHub repository
 * @returns {{ok: true, owner: string, name: string, full: string, directory: string|null}
 *           | {ok: false, reason: string, host: string|null}}
 */
export function parseRepoRef(raw) {
    let s = String(raw ?? '').trim();
    if (!s) return { ok: false, reason: 'empty reference', host: null };

    // npm shorthands
    if (/^github:/i.test(s)) s = s.slice(7);
    else if (/^gh:/i.test(s)) s = s.slice(3);

    // Strip a VCS prefix and the scp-style separator so every form below is a URL or a path.
    s = s.replace(/^git\+/i, '');
    const scp = s.match(/^git@([^:]+):(.+)$/i);
    if (scp) s = `https://${scp[1]}/${scp[2]}`;
    s = s.replace(/^ssh:\/\/git@/i, 'https://').replace(/^git:\/\//i, 'https://');

    let host = null;
    let path = s;
    let directory = null;

    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
        let url;
        try {
            url = new URL(s);
        } catch {
            return { ok: false, reason: `unreadable URL: ${s.slice(0, 80)}`, host: null };
        }
        host = url.hostname.replace(/^www\./i, '').toLowerCase();
        path = url.pathname;
    } else if (/^[^/]+\.[^/]+\//.test(s)) {
        // A bare host path such as "github.com/owner/name" or "gitlab.com/a/b".
        const cut = s.indexOf('/');
        host = s.slice(0, cut).replace(/^www\./i, '').toLowerCase();
        path = s.slice(cut);
    }

    if (host && host !== 'github.com') {
        return { ok: false, reason: `not hosted on GitHub (${host})`, host };
    }

    const parts = path.split('/').filter(Boolean);
    if (parts.length < 2) {
        return { ok: false, reason: `expected "owner/name", got "${String(raw).slice(0, 80)}"`, host };
    }

    const owner = parts[0];
    let name = parts[1].replace(/\.git$/i, '');

    // A tree/blob URL points inside the repository; the tail after the branch is
    // the package directory, which is how monorepo packages describe themselves.
    if (parts.length > 2 && (parts[2] === 'tree' || parts[2] === 'blob') && parts.length > 4) {
        directory = parts.slice(4).join('/') || null;
    }

    if (!OWNER_CHARS.test(owner) || !NAME_CHARS.test(name) || name === '.' || name === '..') {
        return { ok: false, reason: `"${owner}/${name}" is not a usable repository name`, host };
    }

    return { ok: true, owner, name, full: `${owner}/${name}`, directory };
}

/**
 * Two references name the same repository when they differ only in letter case:
 * GitHub is case-insensitive on both halves and answers `Microsoft/typescript`
 * with `microsoft/TypeScript`. Reporting that as a move would flag most of the
 * ecosystem.
 */
export function sameRepo(a, b) {
    return String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
}

// ---------------------------------------------------------------------------
// Licences
// ---------------------------------------------------------------------------

const NON_INFORMATIVE = new Set([
    '', 'UNKNOWN', 'NONE', 'NOASSERTION', 'SEE LICENSE IN FILE', 'OTHER', 'PROPRIETARY',
    'UNLICENSED', 'ALL RIGHTS RESERVED', 'CUSTOM', 'FREE FOR NON-COMMERCIAL USE',
]);

/** Free text and legacy spellings that map onto an SPDX identifier without guessing. */
const ALIASES = new Map(Object.entries({
    'MIT LICENSE': 'MIT',
    'THE MIT LICENSE': 'MIT',
    'MIT/X11': 'MIT',
    'EXPAT': 'MIT',
    'APACHE': 'APACHE-*',
    'APACHE LICENSE': 'APACHE-*',
    'APACHE SOFTWARE LICENSE': 'APACHE-*',
    'APACHE 2': 'APACHE-2.0',
    'APACHE 2.0': 'APACHE-2.0',
    'APACHE-2': 'APACHE-2.0',
    'APACHE LICENSE 2.0': 'APACHE-2.0',
    'APACHE LICENSE, VERSION 2.0': 'APACHE-2.0',
    'ASL 2.0': 'APACHE-2.0',
    'BSD': 'BSD-*',
    'BSD LICENSE': 'BSD-*',
    'NEW BSD': 'BSD-3-CLAUSE',
    'NEW BSD LICENSE': 'BSD-3-CLAUSE',
    'MODIFIED BSD': 'BSD-3-CLAUSE',
    'SIMPLIFIED BSD': 'BSD-2-CLAUSE',
    'BSD 3-CLAUSE': 'BSD-3-CLAUSE',
    'BSD 2-CLAUSE': 'BSD-2-CLAUSE',
    'ISC LICENSE': 'ISC',
    'ISCL': 'ISC',
    'GNU GPL': 'GPL-*',
    GPL: 'GPL-*',
    'GPLV2': 'GPL-2.0',
    'GPLV3': 'GPL-3.0',
    'GNU LGPL': 'LGPL-*',
    LGPL: 'LGPL-*',
    'LGPLV2.1': 'LGPL-2.1',
    'LGPLV3': 'LGPL-3.0',
    'GNU AGPL': 'AGPL-*',
    AGPL: 'AGPL-*',
    'AGPLV3': 'AGPL-3.0',
    MPL: 'MPL-*',
    'MOZILLA PUBLIC LICENSE': 'MPL-*',
    'MOZILLA PUBLIC LICENSE 2.0': 'MPL-2.0',
    'MPL 2.0': 'MPL-2.0',
    'PYTHON SOFTWARE FOUNDATION LICENSE': 'PSF-2.0',
    PSF: 'PSF-2.0',
    'THE UNLICENSE': 'UNLICENSE',
    'PUBLIC DOMAIN': 'UNLICENSE',
    WTFPL: 'WTFPL',
    'BUSINESS SOURCE LICENSE': 'BUSL-1.1',
    'BUSINESS SOURCE LICENSE 1.1': 'BUSL-1.1',
    BSL: 'BUSL-1.1',
    'BSL-1.1': 'BUSL-1.1',
    'ELASTIC LICENSE': 'ELASTIC-*',
    'ELASTIC LICENSE 2.0': 'ELASTIC-2.0',
    'SERVER SIDE PUBLIC LICENSE': 'SSPL-1.0',
    SSPL: 'SSPL-1.0',
    'FUNCTIONAL SOURCE LICENSE': 'FSL-*',
}));

/** SPDX ids that are the same licence written two ways. */
const SPDX_CANON = new Map(Object.entries({
    'GPL-2.0-ONLY': 'GPL-2.0',
    'GPL-2.0-OR-LATER': 'GPL-2.0',
    'GPL-3.0-ONLY': 'GPL-3.0',
    'GPL-3.0-OR-LATER': 'GPL-3.0',
    'LGPL-2.1-ONLY': 'LGPL-2.1',
    'LGPL-2.1-OR-LATER': 'LGPL-2.1',
    'LGPL-3.0-ONLY': 'LGPL-3.0',
    'LGPL-3.0-OR-LATER': 'LGPL-3.0',
    'AGPL-3.0-ONLY': 'AGPL-3.0',
    'AGPL-3.0-OR-LATER': 'AGPL-3.0',
    'BSD-3-CLAUSE-CLEAR': 'BSD-3-CLAUSE',
}));

/** Licences that are not open source in the sense a dependency policy usually means. */
const SOURCE_AVAILABLE = new Set(['BUSL-1.1', 'SSPL-1.0', 'ELASTIC-2.0', 'ELASTIC-*', 'FSL-*']);

function canonToken(token) {
    let t = String(token ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
    t = t.replace(/^\((.*)\)$/, '$1').trim();
    t = t.replace(/\.$/, '');
    if (!t || NON_INFORMATIVE.has(t) || t.startsWith('SEE LICENSE')) return null;
    if (ALIASES.has(t)) return ALIASES.get(t);
    if (SPDX_CANON.has(t)) return SPDX_CANON.get(t);
    // Anything that already looks like an SPDX id is kept as-is; free prose is not.
    if (/^[A-Z0-9][A-Z0-9.+-]*$/.test(t) && /[0-9-]/.test(t)) return t;
    if (/^[A-Z0-9]{2,10}$/.test(t)) return t;
    return null;
}

/**
 * @param {unknown} value a licence as npm, PyPI or GitHub reports it
 * @returns {{ids: string[], raw: string|null, resolved: boolean}}
 */
export function normalizeLicense(value) {
    let raw = value;
    if (Array.isArray(raw)) raw = raw.map((v) => (v && typeof v === 'object' ? v.type : v)).filter(Boolean).join(' OR ');
    if (raw && typeof raw === 'object') raw = raw.spdx_id ?? raw.type ?? raw.name ?? null;
    const text = raw === null || raw === undefined ? '' : String(raw).trim();
    if (!text) return { ids: [], raw: null, resolved: false };

    // An expression such as "(MIT OR Apache-2.0)" offers a choice, so any of its
    // branches matching the other side is enough to say nothing changed.
    const parts = text
        .replace(/^\(|\)$/g, '')
        .split(/\s+(?:OR|AND)\s+/i)
        .map((p) => p.split(/\s+WITH\s+/i)[0]);

    const ids = [];
    for (const part of parts) {
        const token = canonToken(part);
        if (token && !ids.includes(token)) ids.push(token);
    }
    return { ids, raw: text.slice(0, 120), resolved: ids.length > 0 };
}

/** True when either side is a family wildcard covering the other, or they are equal. */
export function licensesCompatible(a, b) {
    if (a === b) return true;
    const fam = (x) => (x.endsWith('-*') ? x.slice(0, -1) : null);
    const fa = fam(a);
    const fb = fam(b);
    if (fa && b.startsWith(fa)) return true;
    if (fb && a.startsWith(fb)) return true;
    return false;
}

/**
 * @param {string[]} declaredIds
 * @param {string[]} actualIds
 * @returns {'match'|'mismatch'|null} null whenever either side could not be resolved,
 *          which is the common case and must not produce a finding.
 */
export function verdictFromIds(declaredIds, actualIds) {
    if (!declaredIds?.length || !actualIds?.length) return null;
    for (const x of declaredIds) {
        for (const y of actualIds) {
            if (licensesCompatible(x, y)) return 'match';
        }
    }
    return 'mismatch';
}

/**
 * Convenience wrapper for two raw licence strings. Callers that already hold
 * resolved identifiers must use `verdictFromIds` instead - PyPI's licence often
 * only resolves through its classifiers, and rendering those back into a string
 * to re-parse them loses the answer.
 */
export function licenseVerdict(declared, actual) {
    return verdictFromIds(normalizeLicense(declared).ids, normalizeLicense(actual).ids);
}

export function isSourceAvailableLicense(ids) {
    return (ids ?? []).some((id) => SOURCE_AVAILABLE.has(id));
}

/** PyPI puts the real answer in the classifier list far more often than in the free-text field. */
export function licenseFromClassifiers(classifiers) {
    const out = [];
    for (const c of classifiers ?? []) {
        const m = String(c).match(/^License\s*::\s*(?:OSI Approved\s*::\s*)?(.+)$/i);
        if (!m) continue;
        const tail = m[1].trim();
        if (/^OSI Approved$/i.test(tail)) continue;
        const inParens = tail.match(/\(([^)]+)\)\s*$/);
        const candidates = [inParens ? inParens[1] : null, tail.replace(/\s*\([^)]*\)\s*$/, '')].filter(Boolean);
        for (const cand of candidates) {
            const token = canonToken(cand);
            if (token && !out.includes(token)) {
                out.push(token);
                break;
            }
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// Dependency manifests
// ---------------------------------------------------------------------------

export const MANIFEST_TYPES = ['package.json', 'requirements.txt', 'go.mod'];

export function detectManifestType(hint, text) {
    const h = String(hint ?? '').toLowerCase();
    if (h.includes('package.json')) return 'package.json';
    if (h.includes('requirements') && h.endsWith('.txt')) return 'requirements.txt';
    if (h.endsWith('go.mod')) return 'go.mod';
    const t = String(text ?? '');
    if (/^\s*module\s+\S+/m.test(t) && /^\s*(require|go)\s/m.test(t)) return 'go.mod';
    if (/^\s*\{/.test(t) && /"(dependencies|devDependencies)"\s*:/.test(t)) return 'package.json';
    if (/^\s*[A-Za-z0-9._-]+\s*(==|>=|~=|<|>|\[|$)/m.test(t)) return 'requirements.txt';
    return null;
}

function parsePackageJson(text, groups) {
    const data = JSON.parse(text);
    const wanted = groups.length ? groups : ['dependencies'];
    const entries = [];
    const seen = new Set();
    for (const group of wanted) {
        const block = data[group];
        if (!block || typeof block !== 'object') continue;
        for (const [name, spec] of Object.entries(block)) {
            const key = `${name}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const specText = String(spec ?? '');
            // A dependency pinned straight at a repository skips the registry entirely.
            const direct = /^(github:|gh:|git\+|git@|https?:\/\/github\.com\/)/i.test(specText)
                ? parseRepoRef(specText)
                : null;
            if (/^(file:|link:|workspace:|portal:)/i.test(specText)) continue;
            entries.push({
                registry: direct?.ok ? null : 'npm',
                name,
                spec: specText,
                group,
                repoRef: direct?.ok ? direct.full : null,
            });
        }
    }
    return { ecosystem: 'npm', entries };
}

function parseRequirements(text) {
    const entries = [];
    const seen = new Set();
    for (const line of String(text).split(/\r?\n/)) {
        let s = line.trim();
        if (!s || s.startsWith('#')) continue;
        s = s.split(' #')[0].trim();
        if (s.startsWith('-')) continue; // -r, -e, --index-url and friends
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) continue; // a bare URL requirement
        const at = s.split(/\s+@\s+/);
        const head = at[0].trim();
        const m = head.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*(.*)$/);
        if (!m) continue;
        const name = m[1];
        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push({
            registry: at.length > 1 ? null : 'pypi',
            name,
            spec: (m[3] || '').split(';')[0].trim(),
            group: 'requirements',
            repoRef: at.length > 1 ? (parseRepoRef(at[1]).full ?? null) : null,
        });
    }
    return { ecosystem: 'pypi', entries };
}

function parseGoMod(text) {
    const entries = [];
    const seen = new Set();
    // Go modules are not all on GitHub - golang.org/x/*, gopkg.in and private
    // hosts are ordinary. They are left out because there is no repository to
    // check, and counted because silently shrinking someone's dependency list
    // reads as "all clear".
    let offGithub = 0;
    let inBlock = false;
    for (const line of String(text).split(/\r?\n/)) {
        const s = line.trim();
        if (!s || s.startsWith('//')) continue;
        if (/^require\s*\($/.test(s)) { inBlock = true; continue; }
        if (inBlock && s === ')') { inBlock = false; continue; }
        let body = null;
        if (inBlock) body = s;
        else if (/^require\s+/.test(s)) body = s.replace(/^require\s+/, '');
        if (!body) continue;

        const indirect = /\/\/\s*indirect/.test(body);
        const path = body.split(/\s+/)[0];
        if (!/^github\.com\//i.test(path)) {
            if (/^[a-z0-9.-]+\.[a-z]{2,}\//i.test(path)) offGithub += 1;
            continue;
        }
        const parts = path.split('/');
        if (parts.length < 3) continue;
        // A major-version suffix ("/v2") is part of the module path, not the repository.
        const owner = parts[1];
        const name = parts[2];
        const full = `${owner}/${name}`;
        if (seen.has(full.toLowerCase())) continue;
        seen.add(full.toLowerCase());
        entries.push({
            registry: null,
            name: path,
            spec: body.split(/\s+/)[1] ?? '',
            group: indirect ? 'indirect' : 'require',
            repoRef: full,
        });
    }
    return { ecosystem: 'go', entries, skippedOffGithub: offGithub };
}

/**
 * @param {string} text the manifest as written
 * @param {string} type one of MANIFEST_TYPES
 * @param {string[]} [groups] which package.json blocks to read
 */
export function parseManifest(text, type, groups = ['dependencies']) {
    if (type === 'package.json') return parsePackageJson(text, groups);
    if (type === 'requirements.txt') return parseRequirements(text);
    if (type === 'go.mod') return parseGoMod(text);
    throw new Error(`Unsupported manifest type "${type}". Supported: ${MANIFEST_TYPES.join(', ')}.`);
}

/** "npm:express", "pypi:requests" or a bare name to be read with the default registry. */
export function parsePackageRef(raw, defaultRegistry) {
    const s = String(raw ?? '').trim();
    if (!s) return null;
    const m = s.match(/^(npm|pypi|pip|python|node):(.+)$/i);
    if (m) {
        const registry = /^(pypi|pip|python)$/i.test(m[1]) ? 'pypi' : 'npm';
        return { registry, name: m[2].trim() };
    }
    return { registry: defaultRegistry === 'pypi' ? 'pypi' : 'npm', name: s };
}
