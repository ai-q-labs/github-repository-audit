/**
 * Working out what to audit.
 *
 * Three ways in - a list of repositories, a list of packages, or a dependency
 * manifest - all collapse into one list of targets. Each target knows where it
 * came from, because "you asked for this repository" and "your lockfile points
 * at this repository" lead to different findings.
 *
 * The one thing worth stating plainly: a manifest of 300 packages does not mean
 * 300 repositories. Monorepos are the norm now, and every `@babel/*` package
 * points at `babel/babel`. Deduplicating before the GitHub calls go out is not
 * an optimisation; without it a modest manifest exhausts an unauthenticated
 * hourly allowance before it reaches the interesting rows.
 */

import { fetchText } from './http.js';
import { detectManifestType, parseManifest, parsePackageRef, parseRepoRef } from './parse.js';

/**
 * @returns {{targets: object[], notes: string[]}}
 */
export function targetsFromRepos(list) {
    const targets = [];
    const notes = [];
    for (const raw of list) {
        const parsed = parseRepoRef(raw);
        if (!parsed.ok) {
            notes.push(`Skipped "${String(raw).slice(0, 80)}": ${parsed.reason}.`);
            continue;
        }
        targets.push({
            source: 'repos',
            input: String(raw).slice(0, 200),
            requestedRepo: parsed.full,
            directory: parsed.directory,
            registry: null,
            packageName: null,
            spec: null,
            group: null,
        });
    }
    return { targets, notes };
}

export function targetsFromPackages(list, defaultRegistry) {
    const targets = [];
    const notes = [];
    for (const raw of list) {
        const ref = parsePackageRef(raw, defaultRegistry);
        if (!ref || !ref.name) {
            notes.push(`Skipped "${String(raw).slice(0, 80)}": not a usable package name.`);
            continue;
        }
        targets.push({
            source: 'packages',
            input: String(raw).slice(0, 200),
            requestedRepo: null,
            directory: null,
            registry: ref.registry,
            packageName: ref.name,
            spec: null,
            group: null,
        });
    }
    return { targets, notes };
}

export function targetsFromManifest(text, type, groups) {
    const parsed = parseManifest(text, type, groups);
    const targets = parsed.entries.map((entry) => ({
        source: `manifest:${type}`,
        input: entry.name,
        requestedRepo: entry.repoRef ?? null,
        directory: null,
        registry: entry.registry,
        packageName: entry.registry ? entry.name : null,
        spec: entry.spec || null,
        group: entry.group,
    }));
    const notes = [];
    if (parsed.skippedOffGithub) {
        notes.push(`${parsed.skippedOffGithub} module(s) in the go.mod are not hosted on GitHub `
            + '(golang.org/x, gopkg.in and private hosts are normal) and were left out - there is no repository here to check them against.');
    }
    return { targets, notes, ecosystem: parsed.ecosystem };
}

/**
 * @param {{repos?: string[], packages?: string[], defaultRegistry?: string,
 *          manifestUrl?: string, manifestText?: string, manifestType?: string,
 *          manifestGroups?: string[], timeoutMs?: number}} input
 */
export async function buildTargets(input) {
    const {
        repos = [],
        packages = [],
        defaultRegistry = 'npm',
        manifestUrl = '',
        manifestText = '',
        manifestType = '',
        manifestGroups = ['dependencies'],
        timeoutMs = 30000,
    } = input;

    const targets = [];
    const notes = [];

    const fromRepos = targetsFromRepos(repos);
    targets.push(...fromRepos.targets);
    notes.push(...fromRepos.notes);

    const fromPackages = targetsFromPackages(packages, defaultRegistry);
    targets.push(...fromPackages.targets);
    notes.push(...fromPackages.notes);

    let text = String(manifestText || '');
    let hint = manifestType || '';
    if (!text && manifestUrl) {
        text = await fetchText(manifestUrl, { timeoutMs });
        hint = manifestType || manifestUrl;
    }
    if (text.trim()) {
        const type = manifestType || detectManifestType(hint, text);
        if (!type) {
            notes.push('The manifest could not be identified. Set manifestType to package.json, requirements.txt or go.mod.');
        } else {
            const fromManifest = targetsFromManifest(text, type, manifestGroups);
            targets.push(...fromManifest.targets);
            notes.push(`Read ${fromManifest.targets.length} dependency entr${fromManifest.targets.length === 1 ? 'y' : 'ies'} from the ${type}.`);
            notes.push(...fromManifest.notes);
        }
    }

    // The same package can arrive from two inputs; the same repository from twenty.
    const seen = new Set();
    const unique = [];
    for (const t of targets) {
        const key = t.packageName
            ? `${t.registry}:${t.packageName.toLowerCase()}`
            : `repo:${String(t.requestedRepo).toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(t);
    }
    if (unique.length !== targets.length) {
        notes.push(`Removed ${targets.length - unique.length} duplicate entr${targets.length - unique.length === 1 ? 'y' : 'ies'}.`);
    }

    return { targets: unique, notes };
}
