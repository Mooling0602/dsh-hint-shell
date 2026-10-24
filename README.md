# dsh-hint-shell

> **🌐 Language** · [English](README.md) | [中文（简体）](README.zh.md)

Type `!` in the DeepSeek Harness composer and the rest of the line runs as a shell command, in the working directory of the session you are in.

It is the `!` of a terminal, moved into the chat box: no terminal window, no `bash` tool call of your own, and no model request spent on the command.

## Features

- **The composer tells you it is available.** An empty composer gains `, type ! for shell commands` after the shipped placeholder text, so `!` is discoverable without documenting it separately.
- **The hint appears as you type.** After a bare `!`, a gray `Enter a shell command…` appears right behind it, and the moment you type real text the hint disappears and gives the line back to you.
- **The output goes into the chat.** `!ls` returns its output as a tool call and result, so the next thing you ask the model about already includes it. **No model request is spent on the `!` line itself.**
- **Quoting, pipes, and globs behave as in a terminal.** The command runs through `/bin/sh -c`, or `cmd.exe` on Windows.
- **One setting.** The command length cap, on the plugin's own row under Installed.
- **Nothing else changes.** No new button, no replaced component, no altered keyboard behaviour.

## Installation

In the Plugin page, choose **Add plugin**, then paste this repository address into the input field:

```text
https://github.com/Mooling0602/dsh-hint-shell
```

This repository ships its build output (`index.js`, `client.js`), so a plain Git address is enough and there is no build step to wait for. Restart DSH after it installs.

The same thing from the command line, for scripted setups:

```sh
dsh plugin --profile web add https://github.com/Mooling0602/dsh-hint-shell
```

To update, repeat the same installation with the latest commit. `dsh plugin` forwards to pnpm inside the profile directory, so never edit `~/.dsh/profiles/web/node_modules` by hand: the next pnpm operation overwrites it.

## Usage

1. Make sure the composer is empty.
2. Type `!` and keep typing the command, for example `!ls`, or `!git status`. The hint confirms that the `!` was recognised.
3. Press Enter.

The output is shown in the conversation, and the model can see the command and its result in the next request you send.

## When `!` is a shell prefix and when it is not

`!` is shell intent only when a command follows it on the same line, following the same rule the composer already applies to `/`:

| You type | What happens |
| --- | --- |
| `!ls` | Runs `ls`. |
| `! ls` | Runs `ls`. The space is ignored. |
| `!` alone | Ordinary text, sent to the model as prose. |
| `hello !world` | Ordinary text. A `!` in the middle of a sentence is not a trigger. |

A line that exceeds the command length cap is refused before it runs.

## Limits

A `!` command obeys the same budget as the official `bash` tool, because it is transcribed into an ordinary tool call. The plugin reads that budget from the terminal plugin's own settings page at command time, so a timeout you tighten there applies to the next `!` command without a restart:

| Field | Where it comes from |
| --- | --- |
| `timeoutMs` | the terminal plugin's page (`bash-sandbox`, or `pwsh-sandbox` on Windows) |
| `maxOutputBytes` | the same page |
| `maxCommandChars` | this plugin's own setting, default `10_000` characters |
| logged output | capped at `30_000` characters on the way into the session log |

The length cap is the plugin's own because an ordinary tool call has none to inherit: the model writes the command into the request, so an unbounded line would be sent twice, once as the argument and once as the result's echo.

## What the model sees

A `!` result opens with this line:

```text
[run by the user via `!` prompt symbol]
```

The wire format does not carry who ran a command, so without it the model would read the record as a call it made itself. The line is a hint about provenance, not an isolation boundary; it tells the model what happened instead of leaving it to guess.

## Development

Sources are TypeScript; both shipped JavaScript files are generated.

```sh
npm install          # typescript + esbuild + @types/react + react
npm run typecheck    # tsc --noEmit
npm run build        # src/ -> client.js, host.ts -> index.js
npm test             # composer, shell-line, and installed-Harness format tests
```

`npm run build` is deterministic: on an unchanged tree it leaves `git status` clean. A dirty rebuild means the sources and the committed bundles had already drifted. Commit regenerated bundles with the source change that caused them.

`test/dsh-format.test.ts` drives the host hook against an installed Harness. It resolves the Harness packages from the host installation, and reports a skip when none is available.

### Implementation notes

The composer half reuses machinery the shipped composer already has, so the plugin adds no DOM, does no measurement, and does no positioning:

- **Idle hint.** `LocaleRuntime.prototype.translate` is wrapped, appending one clause to `conversation/placeholder.default` and `placeholder.hero`. Every other key passes through untouched, and uninstalling restores the original method.
- **Armed hint.** The shipped stylesheet already paints this kind of message through `--dsh-composer-hint`. Custom properties inherit, so setting that property on the composer card is enough for the existing rule to draw the text behind the typed `!`, in the shipped caption colour.
- **Draft reading.** The draft comes from `[data-composer-input]`, the editable surface the composer already publishes. Because Lexical commits typed text inside its own update pass, which is not guaranteed to finish before `input` fires, the plugin repaints on the mutation Lexical makes and keeps a deferred `input` read as a safety net.
- **Copy.** Strings live in the plugin's own `dsh-hint-shell` locale namespace, in `src/locales.ts`, in both languages. `locale/*.json` hold only `meta`, which the plugin listing reads through the Host.

The host half hooks `agent/pre-step`, the last point before the loop dispatches a request, and its `reject` decision is what makes a `!` line cost zero tokens. The outcome is recorded as a whole tool exchange rather than a single event, because a tool result with no preceding `tool-call` is a message answering a call that was never made, which a provider rejects. The records are written in the shape the session's format v4 reader validates on reopen; the live append would succeed even for a row that cannot be reopened, which is what the format test guards.

`subprocess` is read optionally rather than declared in `inject`, so the composer hints keep working even when no provider is composed; only execution degrades, and a `!` line then records a tool error naming the missing service.

## Layout

| Path | Purpose |
| --- | --- |
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

## Settings page placement

The entry is registered on `plugins.row.config`, keyed `dsh-hint-shell#dsh-hint-shell`, rather than on `plugins.item`. `plugins.item` *is* the Official group's slot, so registering there lists a third-party bundle's configuration among the built-in plugins; the row-config slot is the one meant for an installed package's own row.
