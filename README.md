# dsh-parallel-sessions（并行会话协调）

> DeepSeek Harness 的跨会话协调插件：当同一个进程中存在并行的任务/会话时，让它们能互相沟通、一个会话引导另一个会话的设计方向；当一项任务会影响另一项任务的阶段时，暂停对方，等本任务完成后再通知对方继续。接收方会话内会显示消息由哪个会话发起。

本插件参考了两个现有插件的设计思路：

- [`dsh-cross-session-approval`](https://github.com/zsjs110110-cpu/dsh-cross-session-approval)：跨会话派活、投递原语、会话别名与注册表思路；
- [`dsh-agent-message`](https://github.com/GengDaPeng/dsh-agent-message)：把跨会话消息显示为带发送方归属的可见 Agent 消息卡片。

两者面向 DSH 0.1.x/0.2.x 早期版本；本插件按当前 **DSH 0.2.1-rc.2** 的 Host Service、Session 事件与 Chat 渲染契约重新实现，并补上了「阶段冲突时暂停/自动恢复」的协作协议。

## 能力

| 工具 | 作用 |
|---|---|
| `parallel_sessions` | 检测同一工作区内并行运行/曾运行过的顶层会话：`ps_` 别名、标题、运行状态、工作目录、暂停关系。用于发现“有并行的任务和会话”。 |
| `parallel_message` | 向另一个会话投递消息。接收方 Chat 会把消息渲染为跨会话消息卡片（`来自会话 <发送方>`），并在消息正文头部标注发送方标题、`ps_` 别名与意图；发送方获得 `messageId` 回执。`intent=guide` 表示引导对方的设计方向。 |
| `parallel_hold` | 当本任务会影响另一个会话的阶段时暂停它：真实停止其当前运行回合、清除其待处理队列（数量会上报），并投递带发送方归属的暂停通知。`until=holder-turn-end`（默认）在本轮任务结束时自动恢复对方；`until=manual` 需要显式恢复。 |
| `parallel_release` | 恢复被本会话暂停的会话，并投递带发起方归属的“继续工作”通知与变更摘要。 |

## 典型流程

1. 会话 A 在推进中发现自己的改动会影响会话 B 正在做的阶段：
   1. `parallel_sessions` → 找到 B 的 `ps_` 别名；
   2. `parallel_hold({ session_id: "ps_...", reason: "我正在重构 B 依赖的 xxx 接口", impact: "B 的联调阶段" })`；
   3. B 的运行回合被真实停止，B 的 Chat 中出现「暂停通知 · 来自「A」」卡片；B 的输入区上方显示 `已暂停 · 等待「A」完成任务`。
2. A 完成任务、本轮结束 → 插件监听 `turn/end` 自动恢复 B，B 收到「恢复通知 · 来自「A」」。
3. 如果 A 只是要沟通（不是暂停）：`parallel_message({ session_id: "ps_...", message: "...", intent: "guide" })`。

## 消息归属如何显示

每条跨会话消息都是真实的持久化 `user/message`，来源字段同时携带结构化归属：

```json
{
  "kind": "agent-message",
  "form": "relay",
  "producer": "parallel-sessions",
  "senderSessionId": "session-...",
  "senderTitle": "设计评审",
  "senderAlias": "ps_xxxxxxxxxx",
  "targetSessionId": "session-...",
  "intent": "guide",
  "summary": "把登录接口的返回结构改成统一 Result 包装"
}
```

- Chat 的内置 `relay` 渲染器据 `form: "relay"` + `senderSessionId` 显示「来自会话 …」并渲染正文；唤醒型投递则显示为“收到任务消息”的回合触发行，展开即可看到正文。
- 插件自带的 Client 半区在接收会话的输入框上方增加一条常驻提示（`conversation.input.dock`）：显示发送方标题、意图、摘要与“打开发送方会话”按钮；被暂停时显示暂停原因与等待对象。
- 正文首行同样由 Host 写入发送方标题与 `ps_` 别名，模型不依赖 UI 也能知道“是谁发来的、该用哪个别名回信”。

## 安装

把本目录作为本地 bundle 安装进当前 profile：

```text
plugin_manager({ action: "install_bundle", target: "<本目录绝对路径>" })
```

安装后插件行与 Client 半区由 `dsh.bundle` / `dsh.client` 自动挂载，无需手改 `cordis.patch.yml`。工具名以 `parallel_` 开头，与 `cross_session_*` 工具可以共存。

## 配置

`cordis.patch.yml` 的插件行支持以下配置（均在代码中有默认值）：

| 键 | 默认 | 说明 |
|---|---|---|
| `guide` | `true` | 检测到并行会话时，向系统提示注入一段简短的协调指引（无并行会话时不注入，避免常驻 token）。 |
| `autoReleaseOnTurnEnd` | `true` | `holder-turn-end` 暂停在发起方回合结束时自动恢复。 |
| `holdCancel` | `true` | 暂停时真正取消目标运行中的回合（`agent.cancel({kind:'user'})`，会清空其待处理队列）。 |
| `maxHolds` | `8` | 同时存在的暂停登记上限。 |
| `pairMessageLimit` / `pairWindowMs` | `10` / `60000` | 同一对会话在滚动窗口内的投递上限，防止两个 Agent 互相刷屏。 |
| `maxTextBytes` | `32768` | 单条消息正文的 UTF-8 字节上限。 |

## 边界与已知限制

- 只协调**同一工作区**的**顶层会话**：归档会话、子代理（`origin: subagent`）与跨工作区会话会被拒绝。
- 暂停只对**已加载**（running/idle）的会话有效；offline 会话没有可停止的运行任务，可改用 `parallel_message` 留言（会自动恢复后排队投递）。
- 暂停登记保存在进程内存中：Harness 重启后不会自动恢复已暂停的会话；重启前请先 `parallel_release`。
- `agent.cancel` 的停止语义属于宿主：它停止当前回合并清空待处理队列。需要保留队列时请把 `holdCancel` 设为 `false`（此时暂停仅记录登记并发通知，等待对方自然空闲）。
- 会话 ID 可能被显示链路遮蔽；所有工具优先使用 `ps_` 别名寻址，收到遮蔽占位符会明确报错而不是猜。
- 本插件不替代权限审批：暂停/恢复不需要提权，但消息投递遵守目标会话自身的权限与审批策略。

## 目录

```
dsh-parallel-sessions/
├── lib/core.js      纯函数：别名、占位符识别、文本截断、归属 source、通知文案、限流
├── lib/index.js     Host：4 个工具、投递/恢复、turn/end 自动恢复、系统提示指引
├── client.js        Client：输入框上方归属/暂停提示条
├── cordis.patch.yml 自注册补丁
├── locale/*.json    插件管理器显示元数据
└── test/            node:test 单元测试（纯函数 + mock Host）
```

## 开发验证

```sh
node --test test/*.test.js
node --check lib/index.js && node --check lib/core.js && node --check client.js
```

## 验证记录（DSH 0.2.1-rc.2 / desktop profile）

- 单元测试：18 个用例全部通过（别名/占位符/截断/归属 source/通知文案/限流 + mock Host 的列表、投递、
  离线恢复、暂停、自动恢复、手动恢复、非发起方拒绝恢复、重复暂停拒绝、消息洪泛限流、系统提示分区）。
- 安装：`plugin_manager install_bundle` 返回 `application: applied`，profile 的 bundles 与依赖已包含本插件，
  `parallel_*` 工具进入模型可用工具表；Client Slot `conversation.input.dock` 出现
  `dsh-parallel-sessions-client / parallel-sessions`（active）。
- 真实双会话自测：
  - 目标会话运行 `sleep 90` 时被 `parallel_hold` 暂停，宿主日志出现
    `turn/end {reason:{kind:'aborted', reason:{kind:'user'}}}`，证明是真实中止而不是只发消息；
  - 持久化 `user/message` 的 `source` 字段包含 `kind:'agent-message'`、`form:'relay'`、
    `producer:'parallel-sessions'`、`senderSessionId`、`senderTitle`、`senderAlias`、`intent`、`summary`，
    接收方 Chat 的内置 relay 渲染器据此显示「来自会话 …」；
  - 发起方会话在 `until=holder-turn-end` 暂停后结束本轮，目标会话随后自动收到
    `intent:'release'` 的「恢复通知」并继续；发起方未调用 `parallel_release`；
  - 目标会话用 `parallel_message` 回信发起方，双向沟通与归属显示均正常。
- 视觉渲染：无浏览器控制，未做截图级验证；已确认 Client Slot 注册为 active，实际观感请在该会话输入框上方查看。

## 仓库

- GitHub: <https://github.com/CatLollipop/dsh-parallel-sessions>

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)


