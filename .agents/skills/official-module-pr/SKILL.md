---
name: official-module-pr
description: >-
  Package reviewed official module source and open a contributor pull request to
  Flowdular/official-modules with reproducible evidence, without publishing the
  registry.
---
# Submit an official module

Read CONTRIBUTING.md and `.github/PULL_REQUEST_TEMPLATE.md`. Confirm the current
spec approval, exact-source review, passing required checks and final diff. Include
only the requested module change, its tests, documentation and review evidence.

Work on a contributor branch. Use an existing fork or create one when the user has
authorized submitting a PR and upstream write access is unavailable. Check git
remotes and GitHub identity first. Preserve unrelated work; never force-push an
unrelated branch or push a contribution directly to upstream main.

```sh
pnpm verify
pnpm release:pack --local
```

The packer creates immutable `registry/releases/<id>/<version>.json` artifacts and
an ignored local catalog. If existing bytes conflict, bump module/package/spec
versions and repeat approval as needed, tests and review. Never overwrite or delete
an old artifact to pass. Exercise the release in a disposable consumer as described
in CONTRIBUTING.md before claiming installation works.

Commit the module, tests, review and new artifact together. Inspect staged paths
and diff for credentials, environment files, runtime state, machine-specific
lockfiles and local overrides. Do not include registry/local-index.json. Ordinary
contributors do not generate registry/index.json: maintainers pin its URLs to a
commit retained in the upstream repository after acceptance.

If the user requested a PR, push the contributor branch and open it against
`Flowdular/official-modules`, base `main`. Reuse an existing PR for that branch.
Write the final PR body to a temporary UTF-8 file, then use the GitHub CLI with
structured arguments, for example:

```sh
gh pr create --repo Flowdular/official-modules --base main   --head contributor:branch --title 'Add inventory module' --body-file /path/to/pr-body.md
```

Replace the examples with the verified owner, branch, title and file. If GitHub
access is unavailable, leave the concrete branch, commit and PR body ready and
report the blocker. Do not mark submission complete without a returned PR URL.
Use a draft PR when required checks remain unavailable and state that clearly;
never describe missing evidence as passed. Maintainers review and merge, then
publish the catalog. Creating a PR does not publish or enable the module.
