# Typed table cell screens

Scope: the screen evidence CONTRIBUTING requires for the list tables released as catalog 0.8.2, expenses 0.8.2 and parties 0.10.2. No module source, migration byte, release artifact or review record changed.

The screens were captured from a disposable consumer application generated with `pnpm create flowdular@0.4.0`, which installed the three modules from the public index (`module install catalog.core@0.8.2`, `expenses.core@0.8.2`, `parties.core@0.10.2`), enabled each through the CLI and ran `setup quick` against a local PGlite database. Every record shown is invented demo data in a local workspace: fictional company names, `.example` contact addresses and invented VAT identifiers. No credential, token, session value or real tenant record appears in any image.

- `../assets/screens/catalog-1440.png`: the catalog list at 1440 px. Name over unit as a stacked cell, SKU as code, kind and status as tags, price as a right-aligned number.
- `../assets/screens/expenses-1440.png`: the expense claims list at 1440 px. Claim title over a monospaced claim id, expense date as a date cell, category as text, amount right-aligned, status tag per decision state.
- `../assets/screens/parties-1440.png`: the customer list at 1440 px. Party name over its contact line, type as text, VAT identifier as code with a muted placeholder when unset, status as a tag.
- `../assets/screens/expenses-900.png`: the same expense claims list at 900 px. Expense date, category, decision note and created date hide at that width, the row actions fold into one menu, and the first row is expanded so the hidden values appear in its details list, including the muted "No comment" placeholder.

The catalog and party lists hide their priority 2 updated column at 1440 px because the workspace rail leaves 1180 px for the page. The party type cell shortens "Customer and supplier" with an ellipsis at its declared 140 px width. Both are the declared column behavior, not a capture artifact.

`pnpm verify` passed on this branch: RuleSync check, typechecking, 214 tests (55 catalog, 70 expenses, 86 parties, 3 consumer) and module validation. No screen behavior changed, so the release review records for the three modules stay valid at their current source digests.
