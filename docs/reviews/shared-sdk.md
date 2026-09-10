# Shared SDK migration review

The npm publication surface is now `@flowdular/sdk`, `flowdular` and `create-flowdular`, all at `0.1.0`. This replaces the individual-package proposal described by the earlier transfer review.

Expenses and catalog are released as `0.6.1`; parties is `0.8.1`. Their source imports and package dependencies use SDK subpaths, including `@flowdular/sdk/ui`. Module IDs, permission names, applied SQL migrations and public behavior are preserved. Specification versions match package and manifest versions. Each new artifact has current source-bound review evidence, and the official index pins the immutable artifact commit.

Verification: repository typechecking, validation and all 147 tests passed against the assembled SDK tarball. All 147 official-module tests also passed on a temporary PostgreSQL cluster with restricted runtime roles. A clean generated consumer installed the three source artifacts, enabled composition, validated source hashes and passed typechecking and 155 tests. It also built SDK UI through Octane/Vite without backend imports and invoked the packed sandbox launcher successfully.

The three superseded bootstrap entries were withdrawn from the active catalog because they depended on individual npm packages that will not be published. Their artifacts remain unchanged in history. Regenerating the catalog preserves exactly the three current entries. See `withdrawn-bootstrap-releases.md`.

No actionable SDK migration defect remains in this scope. npm publication and a portable lockfile are pending. The repository remains private; anonymous downloads require public visibility, or a separately configured authenticated distribution path. No repository visibility or access permission was changed by this migration.
