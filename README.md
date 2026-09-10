# Flowdular official modules

Versioned, editable business modules for [Flowdular](https://github.com/Flowdular/flowdular).
The initial modules are expenses, parties and catalog. Authentication and platform
infrastructure remain in the core repository.

## Install

With a Flowdular workspace and a populated official release index:

```sh
pnpm flowdular module search
pnpm flowdular module info expenses.core
pnpm flowdular module install expenses.core@0.6.0
pnpm flowdular module install expenses.core@0.6.0 --apply
pnpm flowdular module enable expenses.core --apply
```

Source installation writes a module lock and never activates code or touches the
database. Enablement is a separate operator action. Updates reject local edits,
modified historical migrations and downgrades. `module validate --locked` checks
installed source hashes. Use `module recover` to inspect an interrupted install.

## Develop and release

Use the exact SDK versions in package.json. Until SDK packages are published,
run the core `release:pack` and test with its tarballs using a temporary workspace
override. Never commit machine-specific tarball paths.

1. Run `pnpm verify` and inspect the final diff against the module requirements.
2. Record actual successful checks, requirements, zero unresolved findings and
   the source hash in `reviews/<module-id>.json`. Use `readModuleSource` and
   `sourceDigest` from `@flowdular/cli/distribution` to calculate the hash.
3. Run `pnpm release:pack --local`. This rejects missing or stale review evidence
   and refuses to replace different bytes at an existing module version.
4. Commit the sources, reviews and `registry/releases` artifacts together.
5. Run `pnpm release:pack --index-only`, then commit the generated index. Artifact
   URLs now point to the immutable source/artifact commit, not a moving branch.
6. Run CI before publishing those commits to main.

For offline validation use `--registry /absolute/path/registry/local-index.json`.
The source format is a bounded JSON bundle of regular files with SHA-256 digests;
there is no archive extraction or downloaded lifecycle-script execution.

A review report is evidence, not a security boundary against a malicious
publisher. The CLI trusts this official repository over HTTPS. Protect publishing
credentials and branch access; require review of release changes.
