# Initial module transfer review

Date: 2026-09-10. Scope: expenses, parties and catalog moved from Flowdular core.

The transfer comparison covered 40 expenses files, 48 parties files and 45 catalog
files. Each module additionally carries the MIT LICENSE. Only package.json differs among the existing core files: workspace ranges
became the exact tested SDK versions and repository ownership moved here. Source,
permissions, SQL, immutable migrations, API handlers, specifications and tests
are byte-identical. Existing module IDs and versions are retained for this first
external release.

Requirements: preserve behavior and tenant isolation, retain migration history,
resolve dependencies outside the authoring workspace, and review precisely the
source bytes placed in the release artifact. `reviews/*.json` binds executable
check evidence to that source set; any source edit requires renewed review.

`pnpm verify` passed against packed SDK artifacts in an independent workspace:
all module typechecks, 50 expenses tests, 63 parties tests, 31 catalog tests and
module schema/layout/dependency validation. The SDK tarballs include the updated
upstream SEO/table/store packages; no local Octane patches remain.

Authorization, CSRF, tenant predicates and lifecycle code were preserved; their
existing regression suites ran here. No new background work or query loops were
introduced by the transfer. No rendered component or translation changed, so no
visual redesign inspection is claimed. PostgreSQL integration coverage is a
separate CI gate; this local run uses embedded PGlite and is not PostgreSQL proof.

No actionable transfer defect remains. Publication still requires the exact SDK
versions to be available on npm. This review is not a fresh production security
certification of the original modules or a guarantee that all defects are absent.
