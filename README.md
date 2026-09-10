<p align="center">
  <img src="docs/assets/official-modules.svg" alt="Flowdular official modules. Editable source. Reviewed releases." width="100%" />
</p>

<p align="center">
  <a href="https://github.com/Flowdular/flowdular">Platform</a> ·
  <a href="CONTRIBUTING.md">Contribute</a> ·
  <a href="registry/index.json">Release index</a> ·
  <a href="LICENSE">MIT license</a>
</p>

# Business modules for Flowdular

Install the modules your business needs, keep their source in your workspace, and adapt them through the same contracts used by the platform.

This repository owns the official business modules and their versioned source releases. [Flowdular core](https://github.com/Flowdular/flowdular) owns authentication, the runtime, shared UI, agents, sandbox and CLI. The [website](https://github.com/Flowdular/landing) lives separately.

> **Initial release:** the SDK packages required by this repository are awaiting their first npm publication. The commands below require those exact versions and the updated Flowdular CLI. All three modules currently declare experimental stability and platform API `0.1.0`.

## Available modules

| Module   | ID              | Version | Source                                            |
| -------- | --------------- | ------- | ------------------------------------------------- |
| Expenses | `expenses.core` | `0.6.0` | [Expense records and workflows](modules/expenses) |
| Parties  | `parties.core`  | `0.8.0` | [Business party records](modules/parties)         |
| Catalog  | `catalog.core`  | `0.6.0` | [Catalog records](modules/catalog)                |

Each module includes its specification, server and client code, English and Polish translations, migrations and tests. The existing `.core` IDs are preserved for compatibility; they do not mean the source must remain in the core repository.

## Install into your workspace

Run these commands from a Flowdular workspace:

```sh
pnpm flowdular module search
pnpm flowdular module info expenses.core

# Inspect the installation plan, then write the reviewed source.
pnpm flowdular module install expenses.core@0.6.0
pnpm flowdular module install expenses.core@0.6.0 --apply

# Compose the installed module into your application.
pnpm flowdular module enable expenses.core --apply
pnpm flowdular module validate --locked
```

Installation resolves compatible module dependencies and records source hashes in a lock file. It writes source only. Enablement is a separate operator action; apply your application's scope grants and migration procedure before use.

```sh
# Preview an update before applying it.
pnpm flowdular module update expenses.core
pnpm flowdular module update expenses.core --apply

# Inspect an interrupted installation before recovery.
pnpm flowdular module recover
```

Updates reject local source edits, changes to historical migrations and downgrades. Keep intentional customizations under version control and reconcile them before updating. The installer does not merge local changes automatically.

## From contribution to installed source

```mermaid
flowchart LR
    A[Specification and source] --> B[Tests and validation]
    B --> C[Review final changes]
    C --> D[Immutable release artifact]
    D --> E[Commit-pinned release index]
    E --> F[CLI installation plan]
    F --> G[Apply source and lock]
    G --> H[Operator enables module]
```

Release artifacts contain bounded, allowlisted files and SHA-256 digests. The packer rejects stale review evidence and refuses to replace different content at an existing version. Remote artifact URLs point to an exact commit in this repository. Installation verifies the artifact and its source files before writing them.

These checks catch compatibility failures, accidental changes and stale evidence. Review records are not signatures or proof that code is bug-free. Publishing access and human review remain part of the trust model.

## Repository layout

```text
modules/                 Editable module source and specifications
reviews/                 Source-bound review evidence for each module
registry/index.json      Official release catalog consumed by the CLI
registry/releases/       Immutable, versioned source artifacts
scripts/build-release.mjs Release packaging and index generation
platform/                Validation baseline for core dependencies
tests/consumer/         Cross-module integration tests
docs/                   Review notes and repository artwork
```

## Work on a module

Use Node.js 24 and the pnpm version declared in `package.json`.

```sh
pnpm install
pnpm verify
```

Read [CONTRIBUTING.md](CONTRIBUTING.md) for specifications, tests, review evidence and release steps. New modules start with an approved specification. Existing modules need tests that demonstrate their changed behavior and preserve public contracts.

Before the initial SDK publication, maintainers can validate against tarballs produced by the core repository's `pnpm release:pack`. Temporary local overrides and their lock files must stay out of commits. After publication, generate and commit a portable `pnpm-lock.yaml` and enable `require-lockfile: true` in both CI jobs.

CI runs module validation and tests, plus a PostgreSQL job with restricted runtime roles. See the [initial transfer review](docs/reviews/initial-transfer.md) for the extraction evidence.

## License

[MIT](LICENSE). Module source remains available in the installed workspace.
