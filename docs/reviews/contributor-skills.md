# Contributor skills review

Reviewed on 2026-09-10 against the request to support agent-assisted module creation,
testing, review and pull requests, with RuleSync as the canonical instruction pipeline.

The four canonical skills in `.ai/skills` cover those phases and use public SDK
subpaths, existing module examples and real repository commands. They require human
approval of the current specification, preserve applied migrations and source-bound
review evidence, and leave registry publication to maintainers. The PR skill supports
forks and requires an actual PR URL before claiming submission. No example module or
external PR was created during this documentation change.

RuleSync 16.21.0 generates Codex and Claude Code instructions from `.ai` and checks
for drift through `pnpm verify`. Generated copies are excluded from independent
Prettier rewriting; canonical sources are formatted before generation. The transitive
tldjs install script is explicitly disabled; instruction generation was tested with
that policy. Root setup retains portable dependency pins.

Validation:

- Four skill-creator `quick_validate.py` checks passed.
- RuleSync generation and `generate --check` passed.
- Canonical documentation and configuration formatting passed.
- `pnpm verify` passed: typechecking, 147 tests and module validation, using the
  documented local SDK/CLI tarball overrides because npm publication is pending.
- The first verification attempt timed out in one existing catalog endpoint test.
  A complete retry passed without changing module source or relaxing test limits.
- No module, applied migration, review record or immutable release artifact changed.
- Temporary absolute tarball overrides and their lockfile were removed before commit.

No actionable findings remain in this change. A clean installation from npm and a
portable lockfile remain follow-up steps after the first SDK/CLI publication.
