# Registry CI after npm publication

Scope: CI setup, portable npm lockfile, installation instructions and generic banner blocks. Module source, migration bytes and release review records are unchanged.

The failed GitHub run 34514478397 stopped in both setup steps: cache required a missing pnpm-lock.yaml, and pnpm/setup@v2 does not support require-lockfile. The workflow now disables implicit installation and runs an explicit pnpm install --frozen-lockfile after setup. Its cache uses the committed lockfile. Exact exclusions for the freshly published SDK and CLI preserve the release-age policy for all other dependencies.

Local evidence: npm installation without local overrides passed; frozen installation passed; pnpm verify passed (147 tests, typecheck, RuleSync and module validation); pnpm release:pack --local passed (3 reviewed releases). Lockfile has no machine-specific or tarball overrides. PostgreSQL remains covered by the existing restricted-role CI job; remote result is pending at this commit.

Banner removes specific module names and replaces them with generic connected cubes. XML comparison confirms the embedded existing logo is unchanged. SVG loaded in the in-app browser; accessible description describes generic blocks.

Review: dependency pins and module contracts are preserved. No application authentication, tenant, migration or lifecycle code changed. No new module source review records are required. CI retains all previous test and release gates.
