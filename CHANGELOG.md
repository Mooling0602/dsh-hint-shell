# CHANGELOG

The changelog of every released version, and the source `release.yml` assembles release notes from. Version sections are ordered newest first; CI locates each section by its heading, so the order is for readers only.

For CI, every version's release note is assembled from `Header` and `Endfix`, excluding their titles: the `Header` content goes on the first line and the `Endfix` content on the last. A version section may override either default by declaring an H3-level `Header` or `Endfix` subsection of its own. `**full_changelog!**` is a placeholder tag rather than final content, and CI turns it into a real `Full Changelog` link whose compare range it calculates. CI generates the new version's release note only; it never edits an older one.

## Header

> [!NOTE]
> Copy the attached plugin package link and paste it into dsh's "Add plugin" input field to install or update. Copy the full release-note texts and paste to AI to get the translation for other languages.
>
> 复制插件包链接并粘贴到 dsh 的“添加插件”输入框中，即可安装或更新。复制更新日志全文并粘贴给 AI 以获取中文翻译。

## Endfix

**full_changelog!**

## 0.1.0

### Features

- Turn `!` into a shell prefix in the composer: the rest of the line runs in the session's working directory and its output is recorded as a tool call and result, so the line costs no model request.
- Append `, type ! for shell commands` to the shipped composer placeholder, so `!` is discoverable without separate documentation.
- Paint a gray `Enter a shell command…` behind a bare `!`, and clear it the moment real text follows.
- Inherit the official `bash` tool's budget from the terminal plugin's own settings page at command time, so a timeout tightened there applies to the next `!` command without a restart.
- Add one setting on the plugin's own row under Installed: a command length cap, default `10_000` characters, refused before the command spawns.
- Open every `!` result with a provenance line naming the user as the runner, because the wire format does not otherwise carry who ran a command.
- Resolve the working directory and the subprocess service optionally, so the composer hints keep working when no provider is composed and only execution degrades.

### Fixes

- Match the appended hint's punctuation to the placeholder it follows.
