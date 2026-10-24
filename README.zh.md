# dsh-hint-shell

> **🌐 语言切换** · [English](README.md) | [中文（简体）](README.zh.md)

在 DeepSeek Harness 的输入框里打一个 `!`，这一行剩下的内容就会作为 shell 命令，在你当前会话的工作目录里执行。

它相当于把终端里的 `!` 搬进了聊天框：不用开终端窗口，不用自己发一个 `bash` 工具调用，这一行命令也不消耗任何模型请求。

## 功能

- **输入框会告诉你它可用。** 空输入框在原占位文案后追加 `，输入 ! 执行 shell 命令`，因此不用额外写文档说明，`!` 也能被发现。
- **打字时就有提示。** 只打了一个 `!` 时，紧跟其后出现灰色提示 `输入 shell 命令…`；一旦你开始输入真正的命令内容，提示就消失，把这一行交还给你。
- **输出进入对话。** `!ls` 的结果以工具调用与工具结果的形式出现，所以你下一次问模型的内容里已经包含了它。**`!` 这一行本身不消耗任何模型请求。**
- **引号、管道和通配符与终端一致。** 命令通过 `/bin/sh -c` 执行，Windows 上为 `cmd.exe`。
- **只有一个设置项。** 命令长度上限，位于「已安装」分组下本插件自己的行里。
- **其余一切不变。** 没有新按钮，没有替换组件，没有改动键盘行为。

## 安装

在插件页选择 **添加插件**，把本仓库地址粘贴进输入框即可：

```text
https://github.com/Mooling0602/dsh-hint-shell
```

本仓库直接发布构建产物（`index.js`、`client.js`），因此普通的 Git 地址就够了，安装时无需等待构建。安装完成后重启 DSH。

同样的操作，命令行形式，供脚本化场景使用：

```sh
dsh plugin --profile web add https://github.com/Mooling0602/dsh-hint-shell
```

更新时，用最新提交重复一次同样的安装即可。`dsh plugin` 会把参数转发给 profile 目录里的 pnpm，因此不要手动改动 `~/.dsh/profiles/web/node_modules`：下一次 pnpm 操作会覆盖它。

## 使用

1. 确认输入框是空的。
2. 输入 `!`，然后接着输入命令，例如 `!ls` 或 `!git status`。提示的出现表示 `!` 已被识别。
3. 按回车。

输出会显示在对话里，你下一次发给模型的请求中，模型就能看到这条命令及其结果。

## `!` 何时是 shell 前缀，何时不是

只有当同一行里 `!` 后面跟着命令时，它才是 shell 意图。这与输入框对 `/` 已有的规则一致：

| 你输入 | 结果 |
| --- | --- |
| `!ls` | 执行 `ls`。 |
| `! ls` | 执行 `ls`，空格会被忽略。 |
| 单独一个 `!` | 普通文字，作为消息发给模型。 |
| `hello !world` | 普通文字。句子中间的 `!` 不是触发器。 |

超过命令长度上限的一行会在执行前被直接拒绝。

## 限制

`!` 命令会变成普通的工具调用，因此遵守官方 `bash` 工具所用的同一套预算。插件在命令执行时从终端插件自己的设置页面读取该预算，所以你在那里收紧的超时，对下一条 `!` 命令立即生效，无需重启：

| 字段 | 来源 |
| --- | --- |
| `timeoutMs` | 终端插件页面（`bash-sandbox`，Windows 上为 `pwsh-sandbox`） |
| `maxOutputBytes` | 同上 |
| `maxCommandChars` | 本插件自己的设置，默认 `10_000` 字符 |
| 写入日志的输出 | 进入会话日志时上限 `30_000` 字符 |

长度上限由插件自己决定，因为普通工具调用没有可继承的对应限制：模型会把命令写进请求里，因此无上限的一行会被发送两次，一次作为参数，一次作为结果的回显。

## 模型看到什么

每条 `!` 结果都以这一行开头：

```text
[run by the user via `!` prompt symbol]
```

线上格式不携带命令是谁执行的，因此没有这一行的话，模型会把该记录读作它自己发出的调用。这是关于来源的提示，而非隔离边界：它告诉模型发生了什么，而不是让它去猜。

## 开发

源码是 TypeScript；两个发布的 JavaScript 文件都是生成的。

```sh
npm install          # typescript + esbuild + @types/react + react
npm run typecheck    # tsc --noEmit
npm run build        # src/ -> client.js, host.ts -> index.js
npm test             # 输入框、shell 行，以及针对已安装 Harness 的格式测试
```

`npm run build` 是确定性的：在未改动的树上运行后 `git status` 保持干净。若重新构建产生了改动，说明源码与已提交的产物此前已经不一致。重新生成的产物应与引起它的源码改动一起提交。

`test/dsh-format.test.ts` 针对已安装的 Harness 驱动 Host 钩子。它从宿主安装解析 Harness 包，都找不到时报告跳过。

### 实现要点

输入框部分复用了 Harness 输入框已有的机制，因此插件不添加 DOM、不做测量、不做定位：

- **空闲提示。** 包裹 `LocaleRuntime.prototype.translate`，为 `conversation/placeholder.default` 与 `placeholder.hero` 各追加一个分句，其他 key 原样通过；卸载后恢复原始方法。
- **已触发提示。** Harness 的样式表本来就通过 `--dsh-composer-hint` 绘制这类消息。自定义属性会继承，因此在输入框卡片上设置该属性，就足以让既有规则用它自带的说明文字颜色，把文本画在已输入的 `!` 之后。
- **读取草稿。** 草稿来自 `[data-composer-input]`，即输入框已经公开的可编辑区域。由于 Lexical 在自己的更新流程中提交文本，而该流程不保证在 `input` 事件之前完成，插件在 Lexical 实际产生的 mutation 上重绘，并保留一次延迟的 `input` 读取作为兜底。
- **文案。** 字符串放在插件自己的 `dsh-hint-shell` 本地化命名空间里，即 `src/locales.ts`，双语。`locale/*.json` 只保留 `meta`，供插件列表经 Host 读取。

Host 部分挂载 `agent/pre-step`，即主循环派发请求前的最后一个点，它的 `reject` 决定正是 `!` 一行消耗零 token 的原因。结果被记录为一整套工具交互，而不是单个事件，因为缺少前置 `tool-call` 的工具结果等于在回应一个从未发生过的调用，这会被 provider 拒绝。这些记录按会话格式 v4 读取器在重新打开时校验的形状写入；实时追加对无法重新打开的行也会成功，这正是格式测试所要守住的地方。

`subprocess` 是按需读取而非声明在 `inject` 中，因此即使没有 provider 组合，输入框提示依然可用；只有执行会降级，此时 `!` 一行会记录一条指出缺失服务的工具错误。

## 目录结构

| 路径 | 用途 |
| --- | --- |
| `host.ts` | Host 部分：`!` 的 pre-step 钩子、记录配对与来源标注（源码）。 |
| `index.js` | 生成的 Host 模块。请勿编辑。 |
| `client.js` | 生成的客户端 bundle。请勿编辑。 |
| `src/config.ts` | `Config` schema，以及从终端条目读取的限制。 |
| `src/exec.ts` | shell 行解析、执行与输出格式化。 |
| `src/locales.ts` | 全部运行时字符串，双语。 |
| `src/index.ts` | 输入框效果：占位文案分句与提示绘制。 |
| `src/settings-page.tsx` | 在插件所在行注册设置入口。 |
| `src/HintShellCard.tsx` | 设置表单，以及该行的单行摘要。 |
| `src/hint-shell-card-controller.ts` | 基于配置服务的暂存表单控制器。 |
| `src/types.ts` | 所用客户端服务的结构化类型。 |
| `src/host-types.ts` | 所用 Host 服务的结构化类型。 |
| `test/run.test.ts` | 输入框集成测试（假 DOM + 假本地化服务）。 |
| `test/host.test.ts` | shell 行、pre-step 钩子与继承预算测试。 |
| `test/dsh-format.test.ts` | 已安装 Harness 测试：通过真实 Session 追加，再用真实 v4 读取器重开日志。 |
| `cordis.patch.yml` | Profile 的 bundle 行。 |

## 设置页的位置

入口注册在 `plugins.row.config` 上，key 为 `dsh-hint-shell#dsh-hint-shell`，而不是 `plugins.item`。`plugins.item` *就是*官方分组的位置，注册到那里会把第三方 bundle 的配置列进内置插件之中；行配置位置才是为已安装包自己的行准备的。
