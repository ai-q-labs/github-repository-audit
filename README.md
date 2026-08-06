# GitHub Repository Audit: Archived, Moved & Relicensed

Every dependency has two sides. The package registry tells you a version, a licence and — sometimes — a deprecation notice. The repository tells you whether anyone still works on it, who owns it today, and what licence the code is actually under.

Nothing keeps those two sides in sync. This Actor reads both and reports where they disagree.

## The three things a registry will never tell you

**A package that is still served normally while its repository is finished.** `cross-env` is downloaded millions of times a week. npm shows no deprecation notice. Its repository, `kentcdodds/cross-env`, has been archived — read-only, no fixes, no security patches. `npm install` looks exactly the same as it did five years ago.

**A repository that quietly moved.** Ask GitHub for `facebook/create-react-app` and you get `200 OK`. What you actually got back is `react/create-react-app`, in a different organisation. GitHub follows renames and transfers silently, so nothing in the response says the owner changed. Your `package.json`, your security policy and your vendor list all still name the old one. npm's record for `enzyme` still points at `airbnb/enzyme`, which has been `enzymejs/enzyme` for years.

**A licence that changed after you installed it.** The registry keeps the licence that was true when that version was published. The repository has whatever the licence is now. When a project relicenses — BUSL, SSPL, the Elastic Licence — the registry record for old versions does not change, and neither does your audit spreadsheet.

## What comes back

One row per dependency, about forty fields, plus three key-value records:

| Record | What is in it |
|---|---|
| **Dataset** | Every target: registry facts, repository facts, and the findings for each |
| `ACTION_LIST` | Only the rows with something to fix, hardest problems first |
| `LICENSE_REPORT` | The licence inventory, with source-available licences marked and unresolved ones named |
| `SUMMARY` | Counts, the GitHub allowance that was used, and every caveat that applies to this run |

### Telling apart what you asked for

One call can mix three kinds of target: repositories you listed, packages you listed, and everything a dependency manifest expanded into. A manifest URL can turn one field into forty rows.

So every row and every entry starts with the same two fields:

- **`input`** — the exact string that produced this row, as you supplied it
- **`source`** — where it came from: `repos`, `packages`, or `manifest:<type>`

`SUMMARY` repeats its counts per source in `bySource`, beside the flat `byRiskLevel` totals. If a run reports two critical findings, `bySource` says which of your inputs they belong to. This matters most when a caller is not a person looking at a form — an agent reads the counts and reports them, and a count it cannot attribute is a count it cannot act on.

### Findings

| Code | Severity | Meaning |
|---|---|---|
| `silent_abandonment` | critical | The registry shows no deprecation, the repository is archived |
| `repo_archived` | critical | Read-only; no fixes are coming |
| `repo_gone` | critical | GitHub answers 404 |
| `license_mismatch` | critical | The registry and the repository name different licences |
| `release_yanked` | critical | The exact version you depend on was withdrawn |
| `deprecated_on_registry` | high | The registry says so, with the maintainer's message |
| `license_now_source_available` | high | BUSL, SSPL, the Elastic Licence or similar |
| `known_vulnerabilities` | high | The registry lists advisory records for this version |
| `repo_moved` | medium | Renamed or transferred; requests still return 200 |
| `stale_no_push` | medium | No commit for longer than your threshold |
| `license_declared_but_absent` | medium | The registry grants a licence the repository has no file for |
| `fork_behind_upstream` | medium | You depend on a fork; the original is more active |
| `single_maintainer` | medium | One person accounts for almost every commit |
| `license_needs_review` | low | GitHub cannot classify the licence file |
| `no_license_file` | low | No licence anywhere |
| `issues_disabled` | low | No public channel to report a bug |
| `no_repository_link` | low | The registry record links to no source at all |
| `repository_not_on_github` | low | It links somewhere this Actor cannot check |
| `not_checked` | low | The GitHub allowance ran out before this row |

## Input

Give it repositories, package names, or a manifest — or all three.

```json
{
  "manifestUrl": "https://raw.githubusercontent.com/you/yours/main/package.json",
  "manifestGroups": ["dependencies", "devDependencies"],
  "onlyIssues": true
}
```

```json
{
  "packages": ["npm:cross-env", "npm:enzyme", "pypi:requests==2.31.0"],
  "repos": ["facebook/create-react-app"]
}
```

Repository references are accepted in every shape they actually occur in: `owner/name`, a browser URL, `git+ssh://git@github.com/owner/name.git`, `github:owner/name`, and a `tree/` URL deep inside a monorepo (the package directory is kept as a separate field).

Manifests: `package.json`, `requirements.txt`, `go.mod`. Lockfiles and `pyproject.toml` are deliberately **not** supported — they need a real parser, and half-parsing a manifest produces findings about dependencies you do not have.

## Rate limits, plainly

GitHub allows **60 requests an hour per IP address** without a token, and on shared infrastructure that allowance is shared with everyone else on the same machine. This Actor is built around that:

- **One request per repository.** Archived, moved, licence, fork status, last push and open issues all come from the same response.
- **Repositories are deduplicated first.** A manifest with forty `@babel/*` packages is one repository, not forty.
- **Deeper checks are opt-in.** Contributor concentration and last release each cost an extra request per repository, so they are off by default.
- **Running out is reported, not hidden.** Everything collected before the limit is kept, and `SUMMARY` says exactly how many repositories went unchecked and when the allowance resets.

Supplying a `githubToken` — any personal access token, no scopes needed — raises the limit to 5,000 an hour. It is only ever sent to `api.github.com`.

## What it will not do

- **It will not invent a licence conclusion.** Where either side is unresolvable — `SEE LICENSE IN LICENSE`, an empty PyPI licence field, a file GitHub cannot classify — `licenseMatch` is `null` and no mismatch is reported. A false "your licence changed" costs a lawyer's afternoon.
- **It will not call a 404 a deletion.** Without a token GitHub answers 404 for a private repository as well as a deleted one, and those are different problems.
- **It will not turn staleness into abandonment.** "Archived" is the maintainer's own declaration; "no commit for a year" is an inference. Only the first is strong enough for the headline finding.
- **It will not warn about healthy things.** GitHub fails to classify the licence files of lodash, jQuery UI and UglifyJS — all ordinary MIT/BSD projects whose text carries an extra paragraph. That note exists, at the lowest severity, so it can never sit above a real problem.
- **It does not scrape.** Three documented JSON APIs, no key required for any of them: `api.github.com`, `registry.npmjs.org`, `pypi.org`.

## Sources

| | Endpoint | Key needed |
|---|---|---|
| GitHub | `api.github.com/repos/{owner}/{name}` | No (optional token raises the limit) |
| npm | `registry.npmjs.org/{name}/{version or latest}` | No |
| PyPI | `pypi.org/pypi/{name}/{version}/json` | No |

Where a manifest pins an exact version, that version is read rather than the newest one — it is what you actually depend on, and the per-version document is a few kilobytes where the whole-project document can be three megabytes.

---

Built by **Ai-Q Labs**. Other Actors: [Dead Link Checker](https://apify.com/aiqlabs/dead-link-checker), [Article Extractor](https://apify.com/aiqlabs/article-extractor), [SEO Audit](https://apify.com/aiqlabs/seo-audit-tool), [PDF Table Extractor](https://apify.com/aiqlabs/pdf-table-extractor), [Public Procurement Data](https://apify.com/aiqlabs/public-procurement-data).
