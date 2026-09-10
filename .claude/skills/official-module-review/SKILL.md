---
name: official-module-review
description: >-
  Review a finished official module diff against approved requirements and
  executable regression evidence, then record an exact-source release review.
---
# Review the final module

Read CONTRIBUTING.md, the approved spec, the final diff and actual test results.
Review independently from the implementation pass. Inspect consumers and public
contracts as needed; do not treat an earlier passing report as evidence for new bytes.

Check acceptance coverage, API/dependency/version alignment, permissions, tenant
isolation, CSRF, input bounds, forced RLS and immutable migrations. Review lifecycle,
async cleanup, idempotency and cross-module capability use where affected. Check
translations and rendered UI evidence for screen changes. Look for tests that can
pass while the implementation violates the requirement. For a nontrivial fix,
reproduce the original failure or use a disposable mutation to prove the regression
assertion is meaningful; never leave intentional breakage in the working tree.

Report actionable findings with file locations and the observable failure. Fix
blocking findings and rerun affected checks, followed by `pnpm verify`. Record
unavailable PostgreSQL or consumer evidence as a limitation, not a success.

Only after required checks pass, calculate the exact source hash:

```sh
node --input-type=module -e 'import {readModuleSource,sourceDigest} from "flowdular/distribution"; console.log(sourceDigest(await readModuleSource(process.argv[1])))' modules/inventory
```

Use `reviews/catalog.core.json` as the review schema. Write
`reviews/<module-id>.json` containing that sourceSha256, the actual requirements,
findings and actual typecheck/test/validate commands and exit codes. Do not copy
results from another module, fabricate an exit code, or erase unresolved findings
to satisfy packaging. Any source edit requires a fresh review and hash.

The packer rejects stale evidence and nonempty findings. Self-review is evidence
for maintainers, not permission to merge or publish. Handoff names the reviewed
module version, digest, checks, remaining limits and whether packaging can proceed.
