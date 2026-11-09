<div align="center">

<img src="icon.svg" width="88" alt="桌面兜底桥">

# 桌面兜底桥

**给 DSH 装上 Codex 级的 Computer Use，支持 Windows 与 macOS。**

看见屏幕 · 点击 · 输入 · 跨应用 —— 为所有对话提供最终的GUI手段

**中文** | [English](README.en.md)

![License](https://img.shields.io/badge/license-MIT-blue)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-0078d4)
![Execution](https://img.shields.io/badge/execution-dsh--orb-6b46c1)
![Tools](https://img.shields.io/badge/GUI%20tools-13-2f9e44)

</div>

---

## 一句话

DSH 会写代码、会跑命令，但它**看不见屏幕上正在发生什么**，也点不到任何一个按钮。

[dsh-orb](https://github.com/mini-yifan/dsh-orb-cordis) 提供真正的执行器：截屏、鼠标、键盘、13 个 GUI 工具。

**这个插件是中间那一层** —— 让每一个会话都能像使唤 Codex 一样，把"只能用手做"的那一段交出去，同时保证一台机器上**同一时刻只有一个人在动鼠标**。

```text
你的会话 ──computer_task──▶ 桌面工作会话 ──▶ 截屏 / 点击 / 输入
   │                              │
   └──── 结果 + 验证证据 ◀───────┘
```

---

## 和 Codex 的 Computer Use 对齐

| 能力 | Codex | dsh-orb + 本插件 |
| --- | --- | --- |
| 看见屏幕（目标窗口截图） | ✅ | ✅ 每一步基于最新画面 |
| 点击 / 双击 / 右键 / 拖拽 / 滚动 | ✅ | ✅ |
| 键盘输入、组合键、长按 | ✅ | ✅ |
| 识别前台应用、列出应用、启动应用 | ✅ | ✅ |
| 跨多个应用的流程 | ✅ | ✅（一次一段，不整包丢进去） |
| 显式调用 `@Computer` | ✅ | ✅ `@computer` / `@desktop` / `@电脑` |
| 结构化优先（插件 / MCP 先行） | ✅ | ✅ 写进工具判据 |
| 桌面同一时刻一个执行者 | 平台级 | ✅ 任务租约 + 跨进程独占 |
| 随「停止」一起停 | ✅ | ✅ bridge 独立 Shift+Esc / 原对话停止，轨迹回到原对话 |
| 单任务预算上限 | ✅ | ✅ 步数 / 时长可配 |
| 独立光标、后台操作 | macOS 后台操作；Windows 前台独占 | macOS（dsh-orb 后台操作）；Windows（dsh-orb 前台独占） |
| 逐动作人工确认 | ✅ | ⚠️ 部分：敏感动作靠预算与停止，逐动作弹窗未做 |

> 换句话说：**执行能力和 Codex 是同一档，调度和安全模型按 DSH 的实际情况重做过。**
> 平台操作方式与逐动作确认的边界见下文。

---

## 为什么还需要"桥"这一层

dsh-orb 已经把"手"做好了。缺的是**会话层**：

- 谁现在在用桌面？另一个会话提交任务怎么办？
- 开到一半用户点了停止，桌面那个还在点吗？
- 两个 DSH 进程同时开着，谁说了算？
- 依赖没装好时，用户从哪儿知道？

这个插件回答上面四个问题：**任务级租约、FIFO 队列、跨进程独占、随停止中断、启动自检**。

---

## 安装

```sh
dsh plugin add dsh-orb              # 1. 执行后端（必须）
dsh plugin add dsh-desktop-bridge  # 2. 桥（本仓库）
```

装完在插件页能看到两张卡片，桥显示「运行中」：

<p align="center">
  <img src="docs/media/plugin-card.png" width="760" alt="DSH 插件页中的桌面兜底桥，状态运行中">
</p>

然后直接说人话：

> 帮我在计算器里算一下 7×8

想让它**立刻动手、别再权衡**：

> **@computer** 把那个弹窗点掉

---

## 真实使用

下面是在副屏上录下的一次真实运行：任务交给桌面工作会话后，由它逐键按下 `C` → `7` → `×` → `8` → `=`。**结果不是模型心算的，是从计算器界面读回来的。**

<p align="center">
  <img src="docs/media/desktop-task.gif" width="720" alt="桌面工作会话依次按下 C、7、×、8、= 并读回 56">
</p>

<sub>约每 0.4 秒取一帧，播放略快于实时；只截取目标显示器。</sub>

下方是验证后的静止画面：

<p align="center">
  <img src="docs/media/calculator-7x8.png" width="260" alt="计算器显示 7 × 8 = 56，由桌面工作会话按键完成">
</p>

---

## 停止操作：轨迹回到原对话

按 **Shift+Esc**，由 bridge 自己的原生快捷键 helper 接收，再调用 DSH 的取消接口停止当前 worker。
**只需要原版 dsh-orb，不修改 orb，不依赖它的悬浮球按钮、私有协议或运行时路径。**球可以关闭。
快捷键在每次 worker 启动前注册，任务结束或宿主断开后注销。冲突或 helper 启动失败时拒绝开始 GUI 操作并说明原因；
可配置 `stopShortcut: false`，只使用原对话停止按钮。helper 运行中意外退出会请求停止任务。
Windows 使用系统热键注册；macOS 包含原生热键实现，但尚需真机验收。**单按 Esc 不是全局 CMU 停止。**
原版 orb 的球停止按钮只停止球自己的会话，不是 bridge worker 的停止入口。

bridge 立即关闭该 worker 的工具入口，把取消信号传入已执行的工具，并取消 worker turn。
收到 `turn/end` 后，还须等待 `tools/execute` 中已进入的调用（包括 finally 收尾）返回，才释放租约并归档。
`computer_desktop_status` 的 `stopping` 状态表示仍在收尾，不等同“已停止”。不响应取消的调用会继续占有租约。
快捷键停止不取消父 turn；已有工具调用、结果、错误、最后消息和截图引用会压成有界轨迹作为 `computer_task` 结果返回。
同一个父 turn 不得再开 GUI worker；下一轮 `turn/start` 才解除限制。若用户停止的是原对话，轨迹改用
`parent.inject()` 注入，不主动唤醒模型。无需用户管理恢复命令。

| 结果 | 处理 | 下一步 |
| --- | --- | --- |
| 用户按 Shift+Esc | 关闭工具入口、中断 worker；等待调用收尾后归档，轨迹作为工具结果返回 | 当前父 turn 禁止重开 CMU |
| 用户停止父 turn | 同样停止 worker，轨迹注入原对话而不唤醒 | 用户下一条普通消息可使用这些上下文 |
| 达到 `maxRunSeconds` | 中断、释放桌面、归档 worker，把停止原因与轨迹作为工具结果返回 | 原 Agent 根据轨迹继续或新开 worker |
| worker 返回 `error` / `max-tokens` / `refusal` 等非完成原因 | 结束、释放桌面、归档 worker，把失败与已有轨迹交回原对话 | 原 Agent 判断是否换结构化路线或重试 |
| worker 正常完成 | 归档 worker，把完成状态与有界轨迹作为工具结果返回 | 原 Agent 直接答复用户 |
| 排队时停止原对话 | 直接出队，不创建 worker | 终止；悬浮球和快捷键只面向当前运行任务 |

这里没有 `computer_task_resume`。GUI worker 和一次性的 subagent 一样，只服务一次 `computer_task`；完整 worker
日志和截图附件仍留在归档历史中，但不会把每张图都塞进父会话。下一次 GUI 操作会创建新的 worker，并重新观察
当前屏幕，因为它离开期间页面状态可能已经被用户或其它任务改变。

新版本 DSH 仍然提供一次性 `ctx.subagents.start()`，但 bridge 还需要在创建时选中 dsh-orb 的 `computer-use`
preset；当前 subagent 的公开一次性请求没有这个选项，所以这里通过 `sessionController.create()` 创建一个只活一次
的 GUI session。选择 session 只是获得 preset 能力，不改变“一次性、结束后回收”的 subagent 语义。

`computer_task` 会在 worker 运行期间保持当前父 turn 活跃。完成时工具结果进入原 turn；
用户中止父 turn 时，工具结果无法可靠落盘，所以暂停路径改用注入，而不是要求用户再说“继续”。

停止请求无法撤回已送进系统的粘贴或其它输入；取消是否能中断动作取决于原版 orb 的取消实现。
bridge 不提前抛弃执行 Promise，不宣称零延迟中断或回滚，也不以杀掉整个 DSH 进程代替停止 worker。

---

## 什么时候会真的用上它

判据取自 Codex：**当任务依赖一个"光看文件和命令输出无法确认"的图形界面时**，才交给 GUI。

| 需求 | 走哪条 |
| --- | --- |
| 改代码、读文件、批量重命名 | 文件 / shell |
| 有插件、MCP、API、Skill | 结构化接口 |
| 网页内容 | 抓取 / 浏览器自动化 |
| 只能点界面才能改的设置 | **本插件** |
| 只在 GUI 复现的 bug | **本插件** |
| 跨多个应用串起来的流程 | **本插件** |
| 看屏幕 / 问"我在干嘛" | 截屏 + 读图，不走这里 |

**在 full-access 的 Windows 上，它会被用得比想象中少** —— `pwsh` 能调 Win32、能截屏、能读 UI Automation。这是设计意图：只在**真正需要一只手**的时候占用你的桌面。

---

## 边界

> **本仓库不含任何 Computer Use 实现。** 截屏、点击、输入全部由 dsh-orb 提供。这里只做桥接、排队、权限与边界控制。
> **请先安装 dsh-orb**，否则 `computer_task` 会拒绝执行并提示安装。

- **不做观察类任务。** "我现在在干嘛"这类问题，shell 截屏 + 读图更快更准，不必占桌面。
- **不抢占。** 桌面忙时排队或超时，不会打断正在跑的任务。
- **不跨机器。** 控制的是宿主桌面，不是浏览器所在设备。
- **不装作能自动化一切。** 终端类应用、DSH 自身、需要管理员授权的系统弹窗不在范围内。
- **Windows 只有前台。** 它会真的接管指针和键盘；macOS 的后台操作由 dsh-orb 提供，bridge 不额外实现独立光标。
- **macOS 需要系统权限。** Screen Recording 用于看见窗口，Accessibility 用于点击和输入；
  授权对象是承载 dsh-orb 的 DeepSeek Harness 或终端进程。

---

## 抢占怎么处理

```text
提交任务 → 排队 → 获得租约 → 桌面工作会话 → 释放 → 下一个
```

- **任务级独占**，不是"每次点击加锁"。否则会出现 A 打开表单、B 切走窗口、A 在别人的窗口里输入。
- **默认 FIFO**，模型无权插队。
- **跨进程**：用 OS 级独占句柄（Windows 命名管道，macOS/Linux Unix domain socket）声明本次任务的
  控制权；只在 `computer_task` 运行期间持有，任务结束即释放。
- **与悬浮球互斥**：桥接工作时悬浮球会话让位，反之亦然。
- **随停止中断**：你在聊天里点停止，桌面工作会话一并中断。

### 锁的粒度

Windows 和 macOS 使用同一个任务级语义：插件空闲时不占锁；拿到 FIFO 名额后申请跨进程
Computer Use 租约；worker 结束、取消或启动失败后释放，随后才允许下一个任务开始。

| 层级 | Windows | macOS |
| --- | --- | --- |
| 进程内任务队列 | FIFO，单 CMU 任务 | FIFO，单 CMU 任务 |
| 跨进程租约 | 单个 `computer_task` 生命周期 | 单个 `computer_task` 生命周期 |
| OS 原语 | Windows 命名管道 | Unix domain socket |
| 崩溃残留 | 命名管道随进程消失 | 先探测 live listener，确认陈旧后清理 |
| 空闲状态 | 不占用桌面控制权 | 不占用桌面控制权 |

OS handle 属于进程，但 lease 生命周期属于任务，不是插件加载到进程退出的全过程。

---

## 配置

`cordis.patch.yml` 的 `config`：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `mode` | `auto` | `auto` 按判据判断；`explicit_only` 只认 `@computer`；`off` 关闭 |
| `workerPreset` | `computer-use` | 工作会话用的预设，由 dsh-orb 提供 |
| `maxWaitSeconds` | `300` | 桌面繁忙时最长排队时间 |
| `maxRunSeconds` | `600` | 单任务最长占用桌面时间 |
| `maxTasksPerSession` | `1` | 每会话同时在飞的任务数 |
| `stopShortcut` | `true` | bridge 独立全局 Shift+Esc；关闭后只使用原对话停止按钮 |
| `workerProvider` / `workerModel` | 继承 | 工作会话模型，**必须支持图片输入** |

---

## 兼容性

| 项 | 说明 |
| --- | --- |
| DSH | 0.2.x（桌面版实测） |
| 平台 | Windows / macOS；屏幕与输入由 dsh-orb 提供，macOS 使用 Unix domain socket 任务租约 |
| 依赖 | **dsh-orb ≥ 0.2.0**（提供 `computer-use` 预设） |
| 耦合 | 只依赖预设 id 与 `screen-owner` 记录，**不 import dsh-orb 代码**，升级不会在加载期崩 |

预设被改名或缺失时，插件在启动自检里说明，并持续告诉模型"为什么不能用、怎么修"——不会等你要求操作桌面时才撞墙。

---

## 已知问题

- **worker 可能点到被遮挡的窗口。** 首次真实运行时，计算器被其它窗口挡住，几个点击落到了编辑器上，误开了一个标签页（已自行关闭）。目标窗口不在前台时，先手动带到最前。
- **没有原生状态面板。** 状态通过 `computer_desktop_status` 查询。
- **暂停会结束 worker。** 这是有意设计：GUI 页面可能在离开期间变化，下一次 GUI 操作会新建 worker 并重新观察
  当前画面；不会恢复旧页面假设。

---

## 开发

```sh
node --test --test-concurrency=1 "test/*.test.mjs"
```

测试覆盖：FIFO / 超时 / 取消、任务级跨进程租约、一次性归档与轨迹回传、停止后工具拦截、取消信号传播、等待实际调用收尾、同轮禁止重开、独立快捷键生命周期与注册冲突、显式标记识别及缺依赖降级。

设计取舍与完整验证记录见 [docs/design-notes.md](docs/design-notes.md)。

---

## 许可

MIT。
