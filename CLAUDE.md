<!-- Generated from .ai/rules/official-modules.md by pnpm rules:generate. -->

# Official module work

Choose one skill from `.ai/skills/README.md` for the current phase. Read its
canonical SKILL.md and only the supporting references needed for the task.
Source instructions live in `.ai`; never edit generated AGENTS.md, CLAUDE.md,
`.agents/skills` or `.claude/skills` directly. Run `pnpm rules:generate` after edits.

Read CONTRIBUTING.md before changing module source. Preserve other contributors'
edits. New modules require explicit approval of the exact current specification;
an agent cannot approve its own specification. Record the approval reference in
the PR. Do not fabricate approval or test evidence.

Use the pinned public SDK subpaths. Core changes belong in Flowdular/flowdular.
Preserve module IDs, permission IDs, SQL namespaces and applied migrations.
Tenant identity comes from authentication. Use bound SQL, tenant transactions,
forced RLS, explicit permissions, CSRF and bounded mutation input. Never read
another module's database or expose credentials in source, output or evidence.

Run `pnpm verify` before delivery and review the final source against requirements.
Release review records must match the exact source digest and actual passing
checks. Skipped or unavailable checks are not passing evidence. A source change
invalidates its review. Existing versioned release artifacts are immutable.

A contributor opens a PR; maintainers decide inclusion and publication. Do not
push to upstream main, publish npm packages or update the public registry index
as part of an ordinary contribution. Install and enable are distinct operations.
