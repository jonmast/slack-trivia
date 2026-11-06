# Vendored: anti-slop Oxlint plugins

Source repository: <https://github.com/dmmulroy/anti-slop>

Source commit: `13909c9e07590f5a85d93c62712259fe14a883f7` (upstream `main`, cloned with `--depth 1`).

Installed with the upstream `skills/install-anti-slop/scripts/install.mjs` copy step, run from this repository root. The skill's `assets/anti-slop` bundle is byte-identical to upstream `src/` minus the `*.test.ts` suites, so the installed files match upstream source at the commit above.

Installed paths:

- `tools/oxlint/anti-slop/index.ts` — generic `anti-slop` plugin entry point
- `tools/oxlint/anti-slop/rules/**` — 18 generic rules
- `tools/oxlint/anti-slop/shared/**` — shared AST/scope helpers
- `tools/oxlint/anti-slop/effect/index.ts` — opt-in `anti-slop-effect` plugin entry point
- `tools/oxlint/anti-slop/effect/rules/**` — 5 Effect rules
- `tools/oxlint/anti-slop/vendor/eslint-stylistic/**` — vendored ESLint Stylistic comment-aware padding-line engine, including its `LICENSE` and its own `UPSTREAM.md` provenance record

Configuration:

- `oxlint.config.ts` registers both plugins and enables every generic rule plus `oxc/no-accumulating-spread`, and every opt-in Effect rule.
- Dependencies: `oxlint@1.91.0` and `@oxlint/plugins@1.91.0`, pinned exactly as devDependencies.

Deviations from upstream:

- The Effect plugin is enabled even though this repository has no direct `effect` dependency. The user explicitly requested Effect adoption in a later phase; upstream allows the opt-in group when the user requests it.
- Extra `ignorePatterns` beyond the upstream agent-directory list: `dist/**`, `node_modules/**`, `.wrangler/**`, `public/**` (generated output in this repository).
- No source files were modified. Upstream test suites are not vendored (the skill bundle does not include them); rule behavior is therefore exercised only through this repository's own lint run.
