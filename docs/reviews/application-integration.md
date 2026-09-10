# Application integration CI review

Scope: the application-integration workflow job, its Node runner and PostgreSQL
wrapper, pinned generator dependency, documentation and RuleSync test skill.
Module source, migrations, release artifacts and module review records are unchanged.

The job depends on validate and uses the PR checkout's reviewed local catalog.
It installs exact current module versions through the CLI, enables their full
composition through the public CLI API, checks the installation lock and verifies
that every module is enabled. Modules must declare typecheck and test scripts.
The combined app runs typecheck and tests, builds client and SSR output, then
serves login HTML and a JavaScript asset from its compiled server. A server exit,
HTTP 500, missing asset, timeout or failed command fails the job.

Local evidence on Node 24.18.0 and PostgreSQL 17:

- pnpm verify passed: RuleSync, typecheck, 147 tests and module validation.
- pnpm test:application passed: catalog.core, expenses.core and parties.core,
  combined typecheck, 155 tests, client/server build and production HTTP smoke.
- pnpm install --frozen-lockfile, scoped Prettier, node --check, bash -n,
  pnpm rules:check and git diff --check passed.
- Direct runner invocation without isolated database configuration was rejected.
- During implementation, the executable check correctly rejected an outdated
  generated lock, invalid production database/key configuration, a server that
  exited without listening and a migration failure producing HTTP 500. The final
  harness supplies the correct supported configuration without changing SDK code
  or migration bytes.

The wrapper owns a new loopback PostgreSQL cluster and TLS certificate. Production
build and runtime use verified TLS and distinct coreloom_migrator,
coreloom_runtime and coreloom_background roles, all NOSUPERUSER/NOBYPASSRLS.
Schema/default grants follow the SDK database-testing bootstrap: runtime DML and
sequence access, with background table permissions left to migrations. No deployed
DB settings or publishing credential environment variables are forwarded. Checkout
credentials are not persisted. Temporary files and the cluster are removed;
server shutdown is bounded with a final kill fallback. Each subprocess and CI job
has a timeout. Work scales with the number of modules and their dependency graphs.

No application UI or public module contract is changed. The HTTP check proves
startup and asset serving, not authenticated browser journeys; module permission,
tenancy and other behavior remain covered by their suites and the PostgreSQL job.
No npm or registry index publication happens in this workflow.

Local review passes. Remote CI is pending at this commit. Branch protection,
repository visibility and account plan are unchanged; the operator will configure
required statuses manually when available.
