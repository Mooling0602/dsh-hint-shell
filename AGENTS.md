# AGENTS.md

Guidelines for AI agents and contributors working on this repository.

## Language conventions

This project has a strict language split. Follow it for every change:

### English-only content

- **Commit messages** — [Conventional Commits](https://www.conventionalcommits.org/), with the type that matches the change's primary purpose (see [Commit types](#commit-types)). Imperative summary, under ~72 characters.
- **Code comments and docstrings** — every comment in `host.ts`, `src/`, `test/`, and `build.mjs` is English. Comment density is high on purpose: the reasons behind a decision belong next to the decision.
- **Text the model reads** — the provenance line (`[run by the user via \`!\` prompt symbol]`) and anything else injected into a request is English-only. Multilingual prompt scaffolding costs accuracy.
- **Repository docs for maintainers** — `AGENTS.md`, and the code-level sections of the READMEs.

### Localized content

- Every string a **user sees in the UI** lives in `src/locales.ts`, in both the `en` and `zh` dictionaries, typed by `HintLocaleKey`. Add the key to both in the same change; the `Record<HintLocaleKey, string>` annotation is what makes a missing translation a compile error, so never widen it to `Record<string, string>`.
- Components render copy through the locale service; never hard-code user-facing text in a component.
- `locale/en.json` and `locale/zh.json` hold **only** `meta` (title and description for the plugin listing). Runtime strings must not move there: the locale service takes dictionaries by value, and nothing in the client bundle reads a JSON file at runtime, so a string that lived only in JSON would render as a raw key at runtime.
- Runtime error strings surfaced to the client are English (developer-facing).

| Context | Language | Example |
| --- | --- | --- |
| Commit message | English | `fix: keep the synthetic step open on failure` |
| Code comment | English | `// claimed messages are deep-frozen; clone, don't mutate` |
| Model-facing text | English | `[run by the user via \`!\` prompt symbol]` |
| UI string | both | `zh: '恢复默认'`, `en: 'Reset to default'` |
| README prose | both | `README.md` and `README.zh.md` are kept in sync |
| Conversation with the maintainer | Chinese | reply in Simplified Chinese |

## Markdown documents

- **Do not wrap lines.** A paragraph, a list item, and a blockquote paragraph each go on one line, however long that line becomes. Never hard-wrap prose to a fixed column: a hand-wrapped line renders as a hard line break on GitHub, so the wrap is invisible in the source and visible in the output. Tables keep one row per line and fenced code blocks are left alone, because in both the line break is the syntax rather than the layout.
- **`.markdownlint.json` encodes that choice.** `MD013` (line length) is off, which is what makes a long line compliant instead of a defect, and `MD024` permits the same heading text under different parents. markdownlint is a local convenience, not a gate: no workflow runs it, so run `npx --yes markdownlint-cli2 README.md README.zh.md CHANGELOG.md` by hand when you want the feedback.
- **Keep CJK text joined without a space.** When a Chinese line continues on the next source line, the joined result has no space where an English sentence would need one.

## Commit types

Choose the type from what the commit primarily does, and re-check it against the staged diff right before committing. A mixed change takes the type of its main purpose.

| Type | Use for |
| --- | --- |
| `feat`, `fix` | Changes to plugin behavior; append `!` for a breaking change. |
| `refactor` | Restructuring with no behavior change. |
| `build` | `build.mjs`, `package.json` scripts / `files` / `engines`, `tsconfig.json`. |
| `docs` | READMEs, `AGENTS.md`, code-level prose. |
| `test` | Test-only changes. |
| `chore` | Housekeeping that fits no other type. |

## Architecture cheat-sheet

- **Two halves, two build outputs.** `host.ts` is the Host half: it hooks `agent/pre-step`, runs the `!` line through the composed `subprocess` service, and appends the call/result pair to the session. `src/index.ts` is the Client half: the placeholder clause and the composer hint. `src/*.tsx` is the settings page on that same row.
- **Generated files are not committed.** The build writes `dist/index.js` and `dist/client.js`, and `dist/` is git-ignored: the repository ships sources only. The installable artifact is the tarball attached to a GitHub Release, packed by `release.yml` from a fresh build of the tag — see `PUBLISHING.md`. Never edit `dist/index.js` or `dist/client.js` by hand; their banner says so.
- **The build must not touch tracked files.** `npm run build` writes only into the git-ignored `dist/`, so a rebuild leaves `git status` clean. CI and the release workflow both assert that, which catches generated output leaking back into the tree.
- **The Client bundle must stay one self-contained file.** The Client module loader's `require` resolves *host* packages only and cannot resolve relative specifiers, which is why `build.mjs` bundles `src/` into `dist/client.js` instead of shipping it.
- **Externals resolve from one of two tables.** `build.mjs` never bundles a package listed in its `external` array; whether the resulting `require` call can actually resolve depends on where the package comes from:
  - *Platform singletons* — `react`, `react-dom`, `react/jsx-runtime`, `@deepseek-ai/cordis`, `dsh-client-store`, `dsh-client-ui-slots`, `dsh-client-ui-primitives` — are in the shell's frozen seed table (`packages/client/web/src/seed.ts`), so they resolve with nothing declared in `package.json`.
  - *Plugin package rows* must be declared in `package.json` → `dsh.client.external` **when the bundle actually requires them**, or the loader never puts them in the table and the bundle fails at its `require`. Check the built bundle for the truth: `grep -o 'require("[^"]*")' dist/client.js` lists every runtime specifier (run `npm run build` first). A `import type {}` import leaves no `require`, so a type-only dependency does not need the declaration. The current bundle requires exactly two specifiers — `react/jsx-runtime` and `@deepseek-ai/dsh-client-ui-primitives` — so the `@deepseek-ai/dsh-client-ui-plugin-manager` entry in `dsh.client.external` is a declared-but-unrequired row (it is type-imported only). Leave it alone; it is harmless, and the day a value import appears the declaration is already correct.
  - The Host bundle's externals (`@deepseek-ai/schemastery`, `@deepseek-ai/cordis`) resolve from the Host's own module tree. `schemastery` must stay external because the settings system recognises a schema by class identity, and an inlined copy would be a different class with the same shape.
- **The Host half's `inject` is empty on purpose.** Two different `inject`s exist here and they are not the same thing: `package.json` → `dsh.client.inject` names the Client rows this bundle waits for, while `export const inject = []` in `host.ts` declares the Cordis services the Host half needs. The Host half reads `workingDirectory`, `subprocess`, and the settings entry through `ctx.get(...)` instead of declaring them: a Cordis `inject` would make the plugin refuse to mount when any provider is absent, taking the composer hints down with it. Reading them optionally means the hints always work and only execution degrades.
- **The settings row goes on `plugins.row.config`, keyed `<package name>#<row id>`.** `plugins.item` *is* the Official group's slot; registering there lists a third-party bundle's configuration among the built-in plugins.
- **Toolchain.** TypeScript `strict`, plus `noUncheckedIndexedAccess`, `noUnusedLocals`, and `noUnusedParameters`. Sources, tests, and `build.mjs` are run through Node's type stripping, so `erasableSyntaxOnly` applies: no `enum`, no `namespace`, no parameter properties. `verbatimModuleSyntax` means type-only imports need `import type`. Tests run as `node test/*.test.ts` — there is no test framework, no lint config, and no formatter; match the surrounding style.
- **`dsh API types` are a hand-maintained subset** in `src/types.ts` and `src/host-types.ts`. dsh ships none, and its interfaces carry breaking changes.

## Harness install resolution

The tests that drive a real Harness need the installed packages, resolved from the host installation rather than a local dependency — a plugin ships without them. Two layouts have to work:

- **npm global** — `<npm root -g>/@deepseek-ai/dsh/node_modules/@deepseek-ai`.
- **A monorepo checkout** — the directory behind the `dsh` launcher on `PATH`. There the three packages the format test needs do **not** share one `node_modules`: `apps/cli` carries `dsh-session`, while `dsh-session-format-catalog` and `dsh-session-format-v3-to-v4` sit under `packages/session/`. Probe each package separately instead of assuming one directory holds all three.

Rules for anything that locates the installation:

- **Resolve the installation at runtime; never pin an absolute path.** A pinned path is wrong on every machine but the one it was written on, and it silently degrades the test to a skip. Both test files derive every candidate — `DSH_INSTALL` / `DSH`, then the launcher resolved off `PATH` — and must keep doing so.
- **Skip, never fail, when no installation is present.** `npm test` must pass on a machine with no Harness. Report the skip with a reason: a test that returns success without running has stopped guarding anything, and nobody can tell.
- `DSH_MODULES` overrides discovery for plugin development; it points at a directory that *contains* `dsh-session/`, or at the `@deepseek-ai` directory itself.

## Testing conventions

- `npm test` runs three files in order: `run.test.ts` (composer effects against a fake DOM and fake locale), `host.test.ts` (shell-line parsing, the pre-step hook, inherited budget), `dsh-format.test.ts` (append through a real `Session`, then reopen the log through the real v4 reader).
- Each file is standalone, prints `ok` / `FAIL` per check, and sets `process.exitCode`. Add a check by adding a `check('…', () => { … })` block, not by introducing a framework.
- **A test that cannot run must say so.** `host.test.ts` has a `skip(reason)` helper that prints `skip (<reason>)` and folds the count into the summary; `dsh-format.test.ts` reports its whole-file skip with a `console.log` before `process.exit(0)`. Either way the reason is printed: a test that returns success without running has stopped guarding anything, and nobody can tell.
- When changing the recorded event shape, run `dsh-format.test.ts` specifically: the live append succeeds even when the persisted row is invalid, so only the reopen path catches a format regression.

## Correcting wrong content

When a statement turns out to be wrong, delete it — the claim itself and the sentences that hung off it — and write the correct text in its place. Do not leave the repair behind as a record of the mistake.

- **No tombstones.** Nothing in a comment or a doc says what the text used to claim, that it was wrong, or why it was removed: no "previously", no "this used to say", no "no longer carries", no "changed from X to Y". A reader who never saw the old version does not need its obituary, and a reader who did is better served by `git log`.
- **Rationale is not history.** The repository wants the reason behind a decision written next to it, so keep the *forward-looking* reason — "resolve the installation at runtime; a pinned path is wrong on every machine but one" — and cut the *backward-looking* kind: "…rather than the pinned path we removed". Both explain something; only the first still describes the code in front of you.
- **The wrong sentence goes with its tail.** If a paragraph explained the store hash, the store hash is not hard-coded, and the whole thing should go, then the explanation goes too. Deleting the false clause but keeping the sentence attached to it leaves a paragraph arguing about nothing.
- **Docs describe the repository as it is.** A README or `AGENTS.md` that narrates how it arrived at its current shape has become a changelog. Keep that in git.
- **Commit messages are the exception.** A commit body exists to describe what changed and why, so a correction belongs there — that is the one place the before-and-after is the point rather than clutter.

Apply this when editing, not only when cleaning up: writing the correction cleanly the first time is cheaper than writing it as a diff and then removing the diff.

## Workflow notes

- **Commit signing.** `commit.gpgsign` is on with `gpg.format = ssh`; every commit should verify as `G`. Check with `git log --show-signature -1`.
- **Do not commit secrets, tokens, or personal absolute paths** — a home directory looks like `/home/<user>/…`, `/Users/<user>/…`, or `C:\Users\<user>\…`, and none of them mean anything on another machine. Resolve paths at runtime instead.
- **A local modification you did not make is the maintainer's own edit.** Assume that first rather than treating it as stray state to revert; account for it when reading a diff and commit only what you changed.
- **Rewrite only unpushed commits.** `git commit --amend` or a local rebase may fix a commit that is not on `origin`; once pushed, leave it alone and add a new one. Which commits are eligible is settled here; whether to rewrite at all is settled by [Operations that need the maintainer's permission](#operations-that-need-the-maintainers-permission).
- Keep `README.md` and `README.zh.md` in sync — same headings, same claims. A change to one without the other is incomplete.
- The plugin runs in a live profile: **rebuild and let the user restart.** Do not restart the app or start a replacement server on your own.

## Operations that need the maintainer's permission

Four kinds of operation publish or rewrite state that outlives the task and is visible to everyone holding a copy of this repository. For each one: prepare it, show it, and wait for an explicit yes. A general "go ahead" on the surrounding task does not cover them, and neither does silence.

- **Commit messages.** Show the exact text — summary and body, formatted as it will be recorded — next to the staged diff it describes. The maintainer reviews the real message, not a description of it.
- **Tags.** Adding, moving, or deleting a tag changes what a version number means. State the tag name, the commit it will point at, and whether it is annotated.
- **Special pushes.** Anything beyond a plain fast-forward of the current branch: `--force`, `--force-with-lease`, `--delete`, publishing a rewritten history, pushing tags. Give the exact command, and say which remote ref each one moves and what it overwrites.
- **Branch operations.** Creating, renaming, deleting, or resetting a branch — including `git checkout -B`, `git branch -D`, and `git reset --hard`. Name the branch, its current target, and its intended target.

Preparing a change is ordinary work; publishing it is a separate step, and the permission is asked for at the moment of publishing. Passing `typecheck`, `test`, and `build` makes an operation safe to *offer*, never authorized to *run*.

When in doubt, ask with the command ready: a question carrying the exact command and its effect gets answered faster than one that describes it.

## Not applicable here

This repository intentionally differs from the sibling `dsh-web-file-uploader` in ways that matter when carrying conventions over:

- **No npm registry channel.** Releases ship a GitHub Release tarball only; nothing publishes to npm, so there is no registry account, token, or trusted-publisher setup.
- **No Desktop-only features.** This plugin has no local-file-reference logic and no platform-specific branch for it.
