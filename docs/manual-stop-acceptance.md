# 原版 orb 的停止验收

只更新 bridge，保留原版 dsh-orb。此前的 orb 适配包不参与此测试。
彻底退出并重启 DSH，确认 bridge 为 0.5.0，stopShortcut 未关闭。

先测正常完成与消耗：主对话选择 gpt-6-luna，清除 bridge 的 workerProvider / workerModel 覆盖，让 worker 继承
主对话 provider、model 和 reasoningEffort。选定同一个 provider 与推理档位后保持不变。

> @computer 必须使用 computer_task 操作 Windows 计算器，通过界面输入 7×8 并按等号。
> 必须观察到计算器显示结果后再报告。不要心算作答，不使用 shell、脚本或 API 替代界面操作。
> 验证后立即停止，不做额外操作。

每次新建主对话，计算器从同一初始状态开始。先做一轮冒烟，再重复 3 轮。不要运行多个并行 CMU。
记录：是否实际看到 56、用时、worker id、GUI 调用数、截图数、主对话与 worker 各自输入/输出 token、
缓存命中输入 token、重试。总模型消耗合计两边，缓存命中量单独列出，不再重复加进输入总量。
缺少 provider usage 的调用标记为未知；不要让模型根据文本长度估算 token，也不要把截图文件大小当 token。
中断任务可能有未上报的流式 usage，不与正常完成轮次混为同一平均值。报告单轮值和中位数，3 轮只作初步比较。

另测暂停，在新主对话发送：

> @computer 使用 computer_task 打开 Windows 记事本，新建未保存文档，从 1 逐行输入到 200。
> 每次输入工具调用最多输入一个数字和换行，然后等待 1 秒。不要使用 shell、脚本、直接写文件或一次性粘贴全部内容。

保持记事本在前台，按一次 Shift+Esc。不要点击 orb 球停止按钮，它面向球自己的会话。

验收：数字不再持续增加；已经发出的最后一笔输入可能完成。等待 5 秒，没有后续输入、自动重开 worker。
原对话收到停止结果及已有轨迹。同一轮重新调用 computer_task 必须被拒绝。
如果工具仍在收尾，computer_desktop_status 返回 stopping=true、busy=true，不应提前显示空闲。

随后在原对话发送“刚才停在哪一步？只依据已有记录回答，不要操作电脑”。模型应能使用回传轨迹。
再启动一次新 GUI 请求并点击原对话 Stop，验证非唤醒轨迹注入路径。

自动验证：npm test 覆盖原生快捷键注册/冲突/注销、停止信号传递、工具 finally 收尾、迟到调用拒绝、
同轮禁止重开、启动失败和启动期间停止等路径。test/fixtures/host-probe.mjs 可在独立 DSH profile 下
验证真实工具流水线；不得将该测试插件安装进用户日常 profile。

macOS 热键实现已包含，但此 Windows 开发环境未进行 macOS 真机测试。
