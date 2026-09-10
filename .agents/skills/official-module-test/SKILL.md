---
name: official-module-test
description: >-
  Test official module behavior against its acceptance scenarios, tenant and
  permission boundaries, PostgreSQL adapters and a real SDK consumer.
---
# Prove a module change

Read the affected spec and implementation. Use `modules/catalog/tests` and
`tests/consumer/agent-tools.test.ts` as executable recipes, not tests to copy with
renamed constants. Map each changed acceptance scenario to a public-boundary test.

For a bug, demonstrate failure before the fix. Test successful behavior plus the
relevant missing identity, missing permission, CSRF, bounded input, not-found and
cross-tenant cases. Assert responses and persisted outcomes. Test idempotency,
rollback, retries and disposal when those contracts change. Do not mock away the
authentication, repository or harness boundary whose behavior is under test.

Use the SDK `/database-testing` provider and the adapter selection pattern in the
existing tests. Default local tests use embedded PGlite. PostgreSQL evidence must
use the restricted migrator/runtime/background roles described in
`.github/workflows/validate.yml`; use a dedicated test database only. Running with
SUPERUSER or BYPASSRLS cannot prove tenant isolation. Applied migration bytes stay
unchanged. New SQL and embedded migration SQL must match.

From the repository root, replacing the example package name:

```sh
pnpm --filter @flowdular/module-inventory typecheck
pnpm --filter @flowdular/module-inventory test
pnpm validate
pnpm verify
```

`pnpm verify` includes RuleSync drift checking. Follow CONTRIBUTING.md for pending
npm publication and local tarballs; do not change dependency pins to conceal an
unavailable package. Report failed, skipped and unavailable checks accurately.
No tests, skipped suites or a typecheck alone do not prove the feature works.

For source distribution, use the reviewed local artifact procedure in
CONTRIBUTING.md and a disposable generated application. Preview installation,
apply it, enable the module through the CLI, then typecheck/test/build the consumer.
Exercise changed screens in the rendered application with synthetic data. Verify
SDK client imports do not pull server/database code into the browser. Record the
commands, exit codes and relevant results for the separate final review phase.
