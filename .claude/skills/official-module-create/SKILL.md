---
name: official-module-create
description: >-
  Create a new Flowdular official module from an explicitly approved
  specification, implement its public SDK contracts, and integrate it in a
  disposable consumer.
---
# Create an official module

Read CONTRIBUTING.md and the nearest existing module in `modules/`. Catalog is
the full reference; parties is useful for cross-module capabilities. Inspect the
owning implementation instead of guessing SDK signatures.

## Define and approve the contract

Check the existing modules and issues for overlap. Describe purpose, exclusions,
entities, permissions, capabilities, dependencies and given/when/then acceptance
scenarios in `modules/<directory>/spec/module.yaml`, following the existing schema.
The ID uses dotted segments such as `inventory.core`; the directory is `inventory`.
Link the issue and exact specification revision or SHA256 in the eventual PR.
Obtain explicit human approval of the current spec before implementation. A spec
change invalidates that approval. A `status: approved` field alone is not evidence
that a human approved it. Do not open an issue or send a message unless authorized.

## Scaffold in a real consumer

This repository is a source registry, not a running platform. Use a disposable
application made with the pinned `create-flowdular` release for scaffolding and
preview. Follow the dependency setup in CONTRIBUTING.md if npm is not published.

```sh
npm create flowdular@0.1.0 module-development -- --no-install --no-git
cd module-development
pnpm install
```

Place the approved spec at `modules/<directory>/spec/module.yaml` in that consumer.
Use the human-approved spec with `status: approved`, preserving its agreed bytes.
Replace example identifiers in commands with the actual module ID and directory:

```sh
pnpm flowdular module new inventory.core --spec modules/inventory/spec/module.yaml
pnpm flowdular module new inventory.core --spec modules/inventory/spec/module.yaml --apply
```

The generator provides a starting entity, permissions, repository, routes, tests,
translations and capability-specific client/database files. It does not implement
all acceptance scenarios. Copy only the new module source into this repository's
`modules/`, excluding node_modules, environment files and runtime state. Align its
package scripts, tsconfig and tool versions with the existing modules. Use
`@flowdular/sdk` public subpaths, never unpublished internal packages. Keep module,
package and spec versions identical. Business modules are source releases, not npm.

## Implement the contract

Follow `modules/catalog/src` for the actual public API. Imports include
`@flowdular/sdk/server`, `/contracts`, `/database`, `/client`, `/ui` and
`/modules/auth/server`. Declare SDK and external dependencies in package.json;
keep server-only imports out of client entries. Cross-module access goes through
declared public capabilities, not another module's database.

Implement domain validation in the service, async repositories using the platform
DatabaseProvider, and routes using defineEndpoint with explicit permission and
identity resolution. Derive tenant identity from the principal, validate bounded
input and enforce CSRF for mutations. Follow the reference's migration lease,
runtime lease and disposal lifecycle. Use PostgreSQL SQL, bound values, tenant
predicates and forced RLS. Mirror numbered SQL byte-for-byte in databaseMigrations;
never modify an applied migration. Inspect existing module tests for exact helpers.

Expose server/client composition through module.json and package exports. Build
screens using the SDK UI and shared translations. Keep English and Polish keys
aligned and check loading, empty, error, populated and denied states. Retain
idempotency, recovery and cleanup for any background work.

## Integrate before handoff

Implement acceptance and denial tests, then run the test phase. In the disposable
consumer, install the reviewed local release, enable it through the CLI and verify
actual routes and screens. Never edit generated composition or reset a hosted DB.
Report the spec approval reference, changed files and remaining work. Completion
requires the test, review and PR phases when the user requested end-to-end delivery.
