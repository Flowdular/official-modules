# Official module work

Preserve module IDs, permissions, SQL namespaces and applied migrations.
Use public Flowdular contracts and the pinned SDK. Never read another module's database.
Each change requires requirement-based regression tests and review of the final source.
Run `pnpm verify` before delivery. Review records in `reviews/<module-id>.json`
must match the source digest and contain real passing typecheck/test/validate evidence.
Do not fabricate review evidence or approve a changed specification yourself.
Release scripts reject stale reviews. Install and enable are distinct operations.
