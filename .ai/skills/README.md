# Contributor skills

Canonical sources are here. RuleSync generates discoverable copies for Codex in
`.agents/skills` and Claude Code in `.claude/skills`, plus root instructions.

| Skill                    | Use                                                                |
| ------------------------ | ------------------------------------------------------------------ |
| `official-module-create` | Specification, new module implementation and consumer integration. |
| `official-module-test`   | Requirement-based tests, database isolation and executable checks. |
| `official-module-review` | Final diff review and exact-source release evidence.               |
| `official-module-pr`     | Reviewed artifacts, contributor branch and upstream PR.            |

For an end-to-end request, complete these phases in order. Each skill is also
usable independently. Read one at a time; a skill is not permission to publish,
merge, approve specifications or run against a deployed database.

Edit `.ai`, then run `pnpm rules:generate` and `pnpm rules:check`.
