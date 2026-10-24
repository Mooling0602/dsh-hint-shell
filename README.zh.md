# dsh-hint-shell

一个 DeepSeek Harness 插件，让 `!` 成为输入框里的 shell 前缀。

- **空输入框** — 在原有占位文案后追加 `，输入 ! 执行 shell 命令`。
- **输入 `!` 后** — 在 `!` 之后紧跟显示灰色提示 `输入 shell 命令…`。
- **提交时** — 像 `!ls` 这样的一行会在会话的工作目录里作为真正的 shell 命令执行。
  其结果以工具调用与工具结果的形式记入会话，因此下一次真实请求已经能看到它。
  **`!` 这一行本身不会产生任何模型请求。**
- **设置** — 插件在「已安装」分组下的行里只有一个字段：命令长度上限。shell 自身的
  超时与输出预算**不**在这里重复，而是读取终端插件页面上的值（见[限制](#限制)）。

其余一切不变：没有新按钮，没有替换组件，没有改动键盘行为。

## `!` 与 `/` 遵循同一约定

Harness 只有在触发符号后跟了内容时，才把它当作触发器：`parseCommand` 要求 `/` 之后
至少有一个名称字符，输入框的 `matchEnter` 在 token 为空时会直接返回。因此单独一个
`/` 只是普通文本，不是命令。

`!` 的行为一致。单独的 `!` 是普通文字，会像其他消息一样发给模型；只有 `!` 后面跟着
命令时才是 shell 意图。`!ls` 与 `! ls` 都表示 `ls`。

## 工作原理

输入框部分复用了 Harness 输入框已有的机制。

**空闲提示** — 空输入框的占位文案来自对 `conversation/placeholder.default` 的本地化
查询。`LocaleRuntime.prototype.translate` 是原型方法，因此插件包裹它，并在该 key（以及
`placeholder.hero`，即空会话布局下的同一个输入框）后追加一个分句。其他所有命名空间与
key 都原样通过。

**已触发提示** — Harness 的样式表本来就为这类消息准备了绘制规则：

```css
.input p:last-child::after {
  content: var(--dsh-composer-hint);
  color: var(--dsw-alias-label-caption);
}
```

上游只会在原生命令声明时填充该属性，而 `!` 前缀无法产生这种声明。自定义属性会继承，
因此只要在输入框卡片上设置 `--dsh-composer-hint` 就够了：Harness 的规则随即用其自带的
说明文字颜色，把文本画在已输入的 `!` 之后。插件不添加 DOM、不做测量、不做定位。

草稿文本本身来自 `[data-composer-input]`，即输入框已经公开的可编辑区域，因此本插件没有
配套插件，也不依赖触发器的内部实现。

## 文案

文案放在插件自己的 `dsh-hint-shell` 本地化命名空间里，因此注册永远不会冲突。本地化服务
的 `register` 是追加式的，遇到重复的 `(namespace, locale)` 组合会抛错，这也是插件无法
覆盖 `conversation` 命名空间的原因。

| Key | zh | en |
|---|---|---|
| `idle` | `，输入 ! 执行 shell 命令` | `, type ! for shell commands` |
| `armed` | `输入 shell 命令…` | `Enter a shell command…` |

这两个只是其中一部分：设置页的标签也来自同一命名空间。全部运行时字符串都是
`src/locales.ts` 里的 TypeScript 常量，因为本地化服务按值接收字典，而客户端 bundle 在
运行时不会读取任何 JSON 文件。`locale/*.json` 只保留 `meta`，供插件列表经 Host 读取
——这与 Harness 自带包的做法一致。

## 执行

Host 部分挂载 `agent/pre-step`，即主循环派发请求前的最后一个点，它的 `reject` 决定会
阻止该请求。因此 `!` 一行消耗的 token 为零。

记录结果需要一整套工具交互，而不只是单个事件。模型可见的视图带有 `tool/result`，但没有
`tool/call`，而缺少前置 assistant `tool-call` 块的工具结果，等于在回应一个从未发生过的
调用——这会被 provider 拒绝。因此这些记录按 agent 主循环自身的方式写入，并与会话格式 v4
读取器在重新打开会话时校验的形状一致：

1. `step/start` — `agent/pre-step` 在主循环打开自己的 step *之前*运行，而 v4 要求每条
   视图消息都属于一个已打开的 step。插件为该配对打开一个 step。
2. 内容为空的 `system/message` — 仅在视图仍为空时。V4 把第一条 system 消息保护为视图头部，
   而在此之后无法再追加 `system/message`。`!` 可能是会话里做的第一件事，因此需要预留这个
   头部；空内容不会产生任何模型消息，也不会渲染出对话记录行。
3. 携带 `tool-call` 块的 `assistant/message`（视图事件，带 id 的消息）
4. `tool/call`（仅日志，供 UI 与重放使用）
5. `tool/result`（视图事件：一条带 id 的 tool 角色消息，其 `source.callId` 与
   `toolCallId` 一致，并把 `tool/call` 的 seq 作为其来源事件引用）
6. `step/end` — 关闭这个合成 step，使主循环的 `turn/end` 保持合法

每条消息都带有全新的 UUID `id` 和生产者自有的 `source.kind`，这正是 v4 读取器重新打开时
校验的内容。省略任何一项都不是外观问题：实时追加会成功，随后持久化编码器拒绝该行，缓冲的
批次永远到不了日志，本轮以格式错误失败，例如 `format v4 tool/result at seq 8 requires a
first-class message with a string id`。

由于这些是对持久日志的追加，而该 step 已被拒绝，命令的输出会留在历史中供*下一次*请求使用，
而无需为它本身发起请求。

命令通过 `/bin/sh -c`（Windows 上为 `cmd.exe`）运行，因此引号、管道和通配符的行为与终端一致，
而不是被重新实现。

`subprocess` 是按需读取而非声明在 `inject` 中：硬依赖会导致在没有 provider 组合时 Cordis
拒绝挂载整个插件，从而把输入框提示一并拖垮。没有 provider 时提示仍然可用，`!` 一行则会记录
一条指出缺失服务的工具错误。

## 结果来源标注

每条结果都以这一行开头：

```
[run by the user via `!` prompt symbol]
```

它存在的原因是：否则模型无从知道这条命令是谁执行的。线上格式只携带工具调用的 `type`、
`id`、`name`、`input`，从不携带消息的 `source`，而 v4 *强制*要求 assistant 消息声明模型
来源。因此本插件合成的工具调用，在模型看来与它自己发出的调用无法区分，后续轮次会把这条记录
读作自己先前的动作。

结果文本是该交互中模型唯一真正收到的部分，这也是来源标注放在这里、而非放在消息元数据里的原因。
它加在截断之后，因此既能躲过裁剪，也不占用输出预算；反引号则让 `!` 不会被读作标点。

这是一种提示，不是隔离边界：调用与结果的结构配对依然无法区分。它做的是告诉模型发生了什么，
而不是强制它得出相反结论。

## 限制

`!` 一行会变成普通的工具调用，因此它遵守官方 `bash` 工具所用的同一套预算。插件在命令执行时
从终端插件自己的设置条目读取该预算——`bash-sandbox`，Windows 上为 `pwsh-sandbox`——而不是
另做一套决定：

| 限制 | 来源 | 回退值 |
|---|---|---|
| `timeoutMs` | 终端插件页面 | `120_000`（`bash-local` 的默认值） |
| `maxOutputBytes` | 终端插件页面 | `64_000` |

为一个已经有主的数字再开一个入口，正是两者失步的原因；而收紧过终端超时的用户，会期望每条 `!`
命令都遵守它。实时读取意味着改动对下一条命令即生效，无需重启。

有两项限制刻意由插件自己决定，因为没有官方对应项可供继承：

- **`maxCommandChars`**（默认 `10_000`）— 普通工具调用没有这样的限制。模型会把命令写进
  `tool-call.arguments`，因此无上限的一行会进入下一次请求两次：一次作为参数，一次作为结果的
  回显。
- **记录到日志的输出** — 进入日志时上限为 `30_000` 字符。

## 开发

源码是 TypeScript；两个发布的 JavaScript 文件都是生成的。

```sh
npm install          # typescript + esbuild + @types/react + react
npm run typecheck    # tsc --noEmit
npm run build        # src/ -> client.js, host.ts -> index.js
npm test             # 输入框、shell 行，以及针对已安装 Harness 的格式测试
```

`test/dsh-format.test.ts` 针对已安装的 Harness 驱动 Host 钩子：通过真实的 `Session` 追加，
再用真实的格式 v4 读取器编码、准入并恢复日志，因此一种「实时可用但无法重新打开」的记录形状会让
测试失败。它从宿主安装解析 Harness 包（`DSH_MODULES`，或全局 `npm root -g`），找不到安装时
报告跳过。

`client.js` 必须保持为单个自包含文件：客户端模块加载器的 `require` 只解析宿主包，无法解析相对
导入，这就是构建把 `src/` 打包进来、而不是直接发布它的原因。`index.js` 是构建产物，而非直接
发布 `.ts`，这样宿主就不依赖运行时是否启用了 TypeScript 剥离。

## 目录结构

| 路径 | 用途 |
|---|---|
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

## 行为说明

- 提示只在草稿恰好是 `!` 时显示；输入命令后即消失。`!` 后不需要空格。
- 提示不会在空输入框时出现（那种情况由占位文案负责），也不会出现在句子中间
  （`hello !world` 是普通文本）。
- 提示跟随当前语言；切换语言会重新渲染。
- 卸载后会恢复原始的 `translate`。

### 为什么用到 MutationObserver

可编辑区域属于 Lexical，它在自己的更新流程中把输入的文本提交到自己的段落节点。该流程不保证在
浏览器派发 `input` 之前完成，因此同步读取 `[data-composer-input]` 仍可能描述的是*上一个*字符。
只在 `input` 时读取会让单独的 `!` 晚一个按键才显示——它出现在随后的空格之后，而当草稿退格回到
`!` 时又像是「卡住」了。

因此插件在 Lexical 实际产生的 mutation 上重绘，这是文本已进入 DOM 的权威信号。`input` 上的延迟
读取保留为兜底。两条路径都只是安排一次重绘，因此多余的重绘既廉价又幂等。

## 设置页的位置

入口注册在 `plugins.row.config` 上，key 为 `dsh-hint-shell#dsh-hint-shell`，而不是
`plugins.item`。这并非命名细节：`plugins.item` *就是*官方分组的位置，注册到那里会把第三方
bundle 的配置列进内置插件之中。行配置位置才是为已安装包自己的行准备的。
