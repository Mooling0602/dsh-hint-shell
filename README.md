# dsh-hint-shell

> **🌐 Language** · [English](README.md) | [中文（简体）](README.zh.md)

A DeepSeek Harness plugin that makes `!` a shell prefix in the composer.

- **Empty composer** — appends `, type ! for shell commands` to the shipped
  placeholder.
- **After typing `!`** — shows a gray hint `Enter a shell command…` right after
  the `!`.
- **On submit** — a line like `!ls` runs as a real shell command in the session's
  working directory. Its output is recorded in the session as a tool call and
  result, so the next real request already sees it. **No model request is made
  for the `!` line itself.**
- **Settings** — one field on the plugin's row under Installed: the command
  length cap. The shell's own timeout and output budget are *not* duplicated
  here; they are read from the terminal plugin's page (see
  [Limits](#limits)).

Nothing else changes: no new button, no replaced component, no altered keyboard
behaviour.

## `!` follows the same convention as `/`

The Harness treats a trigger symbol as a trigger only once something follows it:
`parseCommand` requires at least one name character after `/`, and the
composer's `matchEnter` bails when the token is empty. A lone `/` is therefore
ordinary text, not a command.

`!` behaves the same way. A lone `!` is prose and is sent to the model like any
other message; only `!` with a command behind it is shell intent. Both `!ls` and
`! ls` mean `ls`.

## How it works

The composer effects reuse machinery the shipped composer already has.

**Idle hint** — the empty-composer placeholder is produced by a locale lookup of
`conversation/placeholder.default`. `LocaleRuntime.prototype.translate` is a
prototype method, so the plugin wraps it and appends one clause to that key (and
to `placeholder.hero`, the same composer in its empty-session layout). Every
other namespace and key passes through untouched.

**Armed hint** — the shipped stylesheet already paints this exact kind of
message:

```css
.input p:last-child::after {
  content: var(--dsh-composer-hint);
  color: var(--dsw-alias-label-caption);
}
```

Upstream only populates that property for a native command claim, which a `!`
prefix cannot produce. Custom properties inherit, so setting
`--dsh-composer-hint` on the composer card is enough: the shipped rule then
draws the text immediately after the typed `!`, in the shipped caption colour.
The plugin adds no DOM, does no measurement, and does no positioning.

The draft itself comes from `[data-composer-input]`, the editable surface the
composer already publishes, so this plugin has no companion plugin and no
dependency on internal trigger internals.

## Copy

Copy lives in the plugin's own `dsh-hint-shell` locale namespace, so registration
can never collide. The locale service's `register` is append-only and throws on a
duplicate `(namespace, locale)` pair, which is why overriding the `conversation`
namespace from a plugin is not possible.

| Key | zh | en |
|---|---|---|
| `idle` | `，输入 ! 执行 shell 命令` | `, type ! for shell commands` |
| `armed` | `输入 shell 命令…` | `Enter a shell command…` |

These two are only half the picture: the settings page renders its own labels
from the same namespace. All runtime strings are TypeScript constants in
`src/locales.ts`, because the locale service takes dictionaries by value and
nothing in the client bundle reads a JSON file at runtime. The `locale/*.json`
files hold only `meta`, which the plugin listing reads through the Host — the
same split the shipped packages use.

## Execution

The host half hooks `agent/pre-step`, the last point before the loop dispatches a
request, and its `reject` decision stops that request. A `!` line therefore costs
zero tokens.

Recording the outcome needs a whole tool exchange, not one event. The
model-visible surface carries `tool/result` but not `tool/call`, and a tool
result with no preceding assistant `tool-call` block is a message answering a
call that was never made — which a provider rejects. The records are written the
way the agent loop writes its own, and in the shape the session's format v4
reader validates when the session is reopened:

1. `step/start` — `agent/pre-step` runs *before* the loop opens its step, and v4
   requires every surface message to belong to an open step. The plugin opens one
   for the pair.
2. `system/message` with empty content — only when the surface is still empty. V4
   protects the first system message as the surface head, and a later
   `system/message` cannot be appended without one. A `!` line can be the first
   thing a session ever does, so the head is reserved; empty content derives to no
   model message and renders no transcript row.
3. `assistant/message` carrying the `tool-call` block (surface event, identified
   message)
4. `tool/call` (log-only, for the UI and replay)
5. `tool/result` (surface event: an identified tool-role message whose
   `source.callId` matches its `toolCallId`, citing the `tool/call` seq as its
   source event)
6. `step/end` — closes the synthetic step so the loop's `turn/end` stays legal

Every message carries a fresh UUID `id` and a producer-owned `source.kind`, which
is what the v4 reader checks on reopen. Omitting any of this is not a cosmetic
problem: the live append succeeds, then the persistence encoder refuses the row,
the buffered batch never reaches the log, and the turn fails with a format error
such as `format v4 tool/result at seq 8 requires a first-class message with a
string id`.

Because these are appends to the durable log and the step was rejected, the
command's output sits in the history for the *next* request without one being
made for it.

Commands run through `/bin/sh -c` (`cmd.exe` on Windows), so quoting, pipes, and
globs behave as in a terminal rather than being re-implemented.

`subprocess` is read optionally rather than declared in `inject`: a hard
dependency would make Cordis refuse to mount the whole plugin when no provider is
composed, taking the composer hints down with it. Without a provider the hints
still work and a `!` line records a tool error naming the missing service.

## Result provenance

Every result opens with this line:

```
[run by the user via `!` prompt symbol]
```

It exists because the model would otherwise have no way to know who ran the
command. The wire format carries only a tool call's `type`, `id`, `name`, and
`input` — never the message `source` — and v4 *requires* an assistant message to
claim a model source. So the tool call this plugin synthesizes is
indistinguishable, to the model, from one it issued itself, and a later turn
would read the record as its own prior action.

The result text is the only part of that exchange the model actually receives,
which is why the attribution lives there rather than in the message metadata. It
is prefixed after truncation, so it survives a cut and spends no output budget;
backticks keep `!` from reading as punctuation.

This is a hint, not an isolation boundary: the call/result pairing is still
structurally indistinguishable. It tells the model what happened rather than
forcing it to conclude otherwise.

## Limits

A `!` line becomes an ordinary tool call, so it obeys the same budget the
official `bash` tool does. The plugin reads that budget at command time from the
terminal plugin's own settings entry — `bash-sandbox`, or `pwsh-sandbox` on
Windows — instead of deciding a second time:

| Limit | Source | Fallback |
|---|---|---|
| `timeoutMs` | terminal plugin page | `120_000` (`bash-local`'s default) |
| `maxOutputBytes` | terminal plugin page | `64_000` |

A second surface for a number that already has one is how the two drift apart,
and a user who tightened the terminal timeout expects every `!` command to obey
it. Reading live means a settings change applies to the next command, with no
restart.

Two limits are deliberately the plugin's own, because no official counterpart
exists to inherit:

- **`maxCommandChars`** (default `10_000`) — an ordinary tool call has no such
  limit. The model writes the command into `tool-call.arguments`, so an unbounded
  line would enter the next request twice over: once as the argument and once as
  the result's echo.
- **Logged output** — capped at `30_000` characters on the way into the log.

## Development

Sources are TypeScript; both shipped JavaScript files are generated.

```sh
npm install          # typescript + esbuild + @types/react + react
npm run typecheck    # tsc --noEmit
npm run build        # src/ -> client.js, host.ts -> index.js
npm test             # composer, shell-line, and installed-Harness format tests
```

`test/dsh-format.test.ts` drives the host hook against an installed Harness: it
appends through a real `Session`, then encodes, admits, and restores the log
through the real format v4 reader, so a record shape the live app accepts but
cannot re-open fails the suite. It resolves the harness packages from the host
installation — `DSH_MODULES`, the global `npm root -g` layout, or the checkout
behind the `dsh` launcher on `PATH` — and reports a skip when none of them is
available.

`client.js` must stay a single self-contained file: the Client module loader's
`require` resolves host packages only and cannot resolve relative imports, which
is why the build bundles `src/` rather than shipping it. `index.js` is built
rather than shipping `.ts` so the host never depends on the runtime having
TypeScript stripping enabled.

## Layout

| Path | Purpose |
|---|---|
| `host.ts` | Host half: the `!` pre-step hook, record pair, and provenance line (source). |
| `index.js` | Generated Host module. Do not edit. |
| `client.js` | Generated Client bundle. Do not edit. |
| `src/config.ts` | The `Config` schema, and the limits read from the terminal entry. |
| `src/exec.ts` | Shell-line parsing, execution, and output formatting. |
| `src/locales.ts` | Every runtime string, in both languages. |
| `src/index.ts` | The composer effects: placeholder clause and hint painting. |
| `src/settings-page.tsx` | Registers the settings entry on the plugin's row. |
| `src/HintShellCard.tsx` | The settings form, and the row's one-line summary. |
| `src/hint-shell-card-controller.ts` | Staged-form controller over the config service. |
| `src/types.ts` | Structural types for the Client services used. |
| `src/host-types.ts` | Structural types for the Host services used. |
| `test/run.test.ts` | Composer integration test (fake DOM + fake locale). |
| `test/host.test.ts` | Shell-line, pre-step hook, and inherited-budget test. |
| `test/dsh-format.test.ts` | Installed-Harness test: append through a real Session, then reopen the log through the real v4 reader. |
| `cordis.patch.yml` | Profile bundle row. |

## Behaviour notes

- The hint shows only while the draft is the bare `!`; typing a command clears
  it. No space is needed after the `!`.
- The hint never shows on an empty composer (the placeholder covers that case) or
  in the middle of a sentence (`hello !world` is ordinary text).
- The hint follows the active locale; switching language re-renders it.
- Uninstalling restores the original `translate`.

### Why a MutationObserver is involved

The editable surface belongs to Lexical, which commits typed text into its own
paragraph nodes inside its update pass. That pass is not guaranteed to finish
before the browser dispatches `input`, so a synchronous read of
`[data-composer-input]` can still describe the *previous* character. Reading only
on `input` made a bare `!` appear one keystroke late — it showed up after the
space that followed, and then appeared to "stick" when the draft was deleted back
to `!`.

The plugin therefore repaints on the mutation Lexical actually makes, which is
the authoritative signal that the text is in the DOM. A deferred read on `input`
remains as a safety net. Both paths only schedule a paint, so an extra paint is
cheap and idempotent.

## Settings page placement

The entry is registered on `plugins.row.config`, keyed
`dsh-hint-shell#dsh-hint-shell`, rather than on `plugins.item`. That is not a
cosmetic choice: `plugins.item` *is* the Official group's slot, so registering
there lists a third-party bundle's configuration among the built-in plugins. The
row-config slot is the one meant for an installed package's own row.
