# 桌面兜底桥（dsh-desktop-bridge）

给**所有会话**一个最后手段工具：把真正需要鼠标键盘的片段委派给一个专用 Computer Use 工作会话，同时保证同一时间只有一个任务占用桌面。

结构化能力（文件、shell、MCP、API、技能）仍然是首选；本插件只补最后一段。

## 它做了什么

| 能力 | 说明 |
| --- | --- |
| `computer_task` | 为一次桌面操作创建一次性 worker；完成或暂停后归档，并把有界轨迹交回原会话 |
| `computer_desktop_status` | 报告桌面是否被占用、排队数量、本会话自己的在飞任务数 |
| 任务级串行 | 从任务被接纳到工作会话结束期间独占桌面；等待者按 FIFO 排队 |
| 屏幕所有者接管 | 运行期间把 dsh-orb 的 screen-owner 指向工作会话，悬浮球的其它会话无法同时操作 |
| 预算 | 单任务执行上限 `maxRunSeconds`，到点中断工作会话 |
| 防递归 | 工作会话本身（`computer-use` 预设）不能再提交桌面任务 |
| 跟着「停止」一起停 | 发起会话的那一轮被中止时，worker 一并中断、归档，并把 Escape 事件与轨迹注入原会话 |

## 什么时候触发（对齐 Codex 的判据）

Codex 的官方判据是一句话：

> Choose Computer Use when the task depends on a graphical user interface that's **hard to verify through files or command output alone**.

它同时把优先级写死：**插件 / MCP 优先，本地 Web 应用优先用内置浏览器**，Computer Use 只处理"必须看见或必须动手"的那一段。

本插件的路由规则据此收敛：

| 需求 | 走哪条 |
| --- | --- |
| 文件、数据、代码、批量操作 | 文件工具 / shell |
| 有对应插件、MCP、API、Skill | 结构化接口 |
| 网页内容 | 抓取 / 浏览器自动化 |
| 只能点界面才能改的设置、只能在 GUI 复现的问题 | **computer_task** |
| 需要跨多个应用串起来 | **computer_task**（一次一段，不要整包丢进去） |

### 显式通道：`@computer`

Codex 最有效的机制不是让模型自己权衡，而是给用户一个 **`@Computer`**。这里同样支持：

- `@computer`、`@desktop`、`@gui`、`@screen`、`@电脑`、`@桌面`
- `/desktop`、`/computer`

**标记是从会话日志里读出来的**，不是模型填的参数——所以模型没法假装用户说过。命中后：

- `mode: explicit_only` 下直接放行，不再要求理由；
- 普通模式下令模型"不必再权衡，直接委派"。

只认**最新一条用户消息**；注入的上下文不算；`@docs/PRD.md` 这类文件引用不会被误判。

### 为什么不做"看屏幕"

实测结论（见文末验证记录）：`我现在在干嘛`、`屏幕最前面是什么` 这类**观察类**问题，用 shell 截屏 + `read_image` 由父会话直接回答更快更准，还不用占桌面。委派反而绕了一圈——子会话看到图，父会话只拿到文字总结，信息有损耗。

**所以 `computer_task` 的价值是"动手"，不是"看"。**

## 配置

`cordis.patch.yml` 里的 `config`：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `mode` | `auto` | `auto` 允许四种理由；`explicit_only` 只允许用户明确要求操作界面；`off` 关闭 |
| `workerPreset` | `computer-use` | 工作会话使用的预设，由 dsh-orb 提供 |
| `spawnProvider` | `spawn` | 仅用于旧 DSH 的一次性 subagent 兼容路径；当前版本主路径使用 SessionController |
| `maxWaitSeconds` | `300` | 桌面繁忙时单任务最长排队时间 |
| `maxRunSeconds` | `600` | 单任务最长占用桌面时间，到点中断 |
| `maxTasksPerSession` | `1` | 每个会话同时最多在飞的桌面任务数 |

### 工作会话的模型

工作会话默认继承发起会话的模型。**Computer Use 需要模型声明支持图片输入**，否则 GUI 工具会拒绝执行并给出明确错误。若默认模型不支持，请显式指定：

```yaml
config:
  workerProvider: your-provider
  workerModel: your-image-capable-model
```

## 紧急停止：为什么不直接用悬浮球的暂停按钮

悬浮球的暂停按钮停的是**悬浮球自己那个会话**。桥接的桌面工作会话是**调用会话的子会话**，是两个不同的 session；dsh-orb 里唯一的跨会话协调面是 `screen-owner`，它没有任何「中断其它会话」的调用。所以按悬浮球的暂停，桥上正在点的那只手不会停。

用户只有一个停止操作：**Esc**，效果等同停掉发起会话的那一轮。插件监听父 `turn/end` 的 `aborted`，中断
worker、释放桌面并归档这个一次性 session。随后它读取 worker 日志，压缩成有界轨迹，并连同“用户按了 Esc”
事件通过 `parent.inject()` 放回原 Agent 会话；注入本身不唤醒模型，用户下一条普通消息会自然接上这段上下文。

这里没有 worker 恢复。正常完成把同一份轨迹作为 `computer_task` 的 `tool/result` 返回；Esc、预算耗尽和
worker 报错都会结束并归档 worker。下一次 GUI 操作会创建新 session，先看当前屏幕，再继续未完成工作。这样
与一次性 subagent 的生命周期一致，也避免在用户离开期间页面变化后继续依赖过期的 GUI 假设。

用户不需要理解 pause 与 cancel：Esc 是唯一停止操作。`maxRunSeconds` 到点也会自动中断，作为预算兜底。

## 前置依赖

**必须先安装并启用 dsh-orb**（它提供 `computer-use` 预设和 GUI 工具）。

DSH 的安装闸门只校验 `engines.dsh` 与 DSH 自身的 peer 包，**不会**因为某个第三方 peer 缺失而拒绝安装（见插件管理器文档的 "Version compatibility"）。所以"前置依赖"要靠下面三层落地：

| 层 | 做法 | 效果 |
| --- | --- | --- |
| 声明 | `peerDependencies.dsh-orb` + `optional: true` | 出现在包清单与 pnpm 的 peer 报告里，可被人与工具读到；标 optional 是为了不让 pnpm 自动装一份竞争副本 |
| 说明 | 插件标题/描述、本 README | 用户在插件列表就能看到前置要求 |
| **强制** | 运行时探测 `agentPresets.list()` 是否含 `computer-use` | 缺失时 `computer_task` 直接拒绝并给出"请安装 dsh-orb"，`computer_desktop_status` 的 `workerPresetReady` 为 `false` |

第三层才是真正拦得住的那道。没有它，缺依赖时只会在子会话里抛出难以理解的错误。

### 启动自检（不是等第一次调用）

插件加载时就探测一次，之后每 30 秒在"不可用"状态下复查一次：

| 时机 | 表现 |
| --- | --- |
| 加载时缺依赖 | 控制台一条明确警告；`computer_desktop_status.workerPresetReady=false` |
| 每次组装提示词 | 注册一个 `desktop-bridge-readiness` 段，缺依赖时给模型一句话，模型据此**主动告诉用户**要装 dsh-orb，且装好后无需重启会话 |
| 依赖就绪 | 该段返回空字符串，**不占常驻上下文** |
| 运行中新装 dsh-orb | 每次提交都会重新探测，装完立刻可用，无需重启 |

这是"告诉用户怎么触发 Computer Use"的落点：模型在第一次对话就知道为什么不能用、缺什么、装完怎么继续，而不是等有人要求操作桌面时才撞墙。

## 与 dsh-orb 升级的关系

**本插件不 import 任何 dsh-orb 代码**，只通过两个字符串级契约桥接，所以 orb 升级不会在加载期把插件带崩：

| 契约 | 类型 | 失效后果 |
| --- | --- | --- |
| 预设 id `computer-use` | 声明式（已做成 `workerPreset` 配置） | 被上方探测拦住，报"请安装 dsh-orb / 改配置" |
| `Symbol.for('dsh-orb.screen-owner')` 与 `{ ownerId }` 结构 | 非公开约定 | **静默降级**：写入没人读，悬浮球不再让位 |

第一个是"响亮的失败"，第二个是"安静的退化"。第二种无法靠探测消除（orb 的 record 是懒创建的，存在与否不代表它在读），只能靠：

- 升级后用 `dsh-orb` 实测一次对撞（`test/interop.test.mjs` 就是拿宿主实际加载的那份 `screen-owner-*.js` 判定的）；
- 或推动 orb 提供一个公开的协调 API。

**即使 screen-owner 失效，本插件自己的串行与跨进程互斥仍然有效**，退化的只是"与悬浮球互斥"这一层。

## 和 dsh-orb 的关系

- 复用 dsh-orb 的 `computer-use` 预设提供截屏与 GUI 工具，不重复实现。
- 复用 dsh-orb 的进程级动作锁（`withScreenLock`）：即使出现意外，两次真实输入也不会同时发生。
- 通过 screen-owner 让悬浮球的其它会话在任务期间让出桌面。
- **前提**：dsh-orb 必须已安装并启用 Computer Use 预设。

## 已知限制

1. **只在最近的宿主上验证过启动链路**：任务的创建、排队、屏幕归属和结果回传已验证；完整的并发抢占场景仍需要在真实桌面上逐条跑验收用例。
2. **跨进程**：bridge 用命名管道或 Unix domain socket 为单个 `computer_task` 申请独占租约；插件加载本身不占用桌面，worker 结束后释放。dsh-orb 自己的动作锁仍只在进程内有效。
3. **人工停止与一次性 worker**：Esc 会中断当前 turn、释放桌面、归档 worker，并把有界轨迹注入原会话；下一次 GUI 操作会新建 worker。
4. **无人值守**：没有实现「定时任务默认拒绝桌面」的开关，需要后续补充。
5. **没有原生 UI**：状态通过工具获取，尚无全局状态面板与紧急停止按钮。PRD 里这属于正式上线必备项。
6. **用户正在操作电脑**时不会自动询问；`mode: auto` 下由模型自行判断，建议需要更严格时改成 `explicit_only`。

## 验证状态

| 项 | 状态 |
| --- | --- |
| 调度器单元测试（FIFO、超时、取消、误释放） | 通过（7 项） |
| 插件行为测试（模式门、防递归、排队、取消、Esc 后轨迹注入与归档、完成后归档、失败收尾、轨迹长度上界、screen-owner 回滚） | 通过（21 项） |
| 显式标记测试（识别、文件引用不误判、只看最新消息、注入上下文不算） | 通过（7 项） |
| 悬浮球对撞（用宿主实际加载的 dsh-orb 代码判定） | 通过（2 项） |
| 跨进程任务租约（加载不占锁、运行持有、失败/结束释放、外部冲突） | 通过（4 项控制通道测试 + 3 项插件生命周期测试） |
| 全会话可见 `computer_task` | 已在标准预设会话验证 |
| 启动 `computer-use` 工作会话 | 已验证：子会话获得截图并正确返回结果 |
| 双会话真并发 | 已验证：A 占用时 B 阻塞 40 秒 |
| 路由行为（3 个真实探针） | **0 次委派**：文件清单、屏幕观察、计算器按键都被结构化手段解决 |

## 安装与回滚

```sh
dsh plugin add <本目录绝对路径>
```

回滚：先等待在飞任务结束，再 `dsh plugin remove dsh-desktop-bridge`。卸载时插件会中断自己的在工作会话并释放桌面。
