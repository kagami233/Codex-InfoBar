# Windows 修复说明

这些修改解决 Windows 安装后后台失联、新对话没有状态条、启动后延迟关闭重开，以及状态条文字和用量圆环中心偏移的问题。修复在项目源码中实现，安装后由持久后台运行，不需要另开终端执行辅助脚本。

## 修改位置

| 文件 | 修改内容 |
| --- | --- |
| `src/install.mjs`、`src/windows-session.mjs` | 安装、卸载和诊断在同一实际 Windows 用户会话执行，避免应用容器的 AppData 视图不一致；独立启动后台并等待就绪。 |
| `src/windows-native.mjs`、`src/windows-native.cs`、`src/platform.mjs` | WMI 独立后台启动、参数转义及进程身份校验；Restart Manager 正常退出尊重客户端否决，不强制终止 Codex。 |
| `src/windows-shortcuts.mjs` | 备份并维护用户现有官方快捷方式的启动目标及回环调试参数，保留图标和应用身份；保护自定义参数和用户编辑；卸载恢复原链接或移除本项目参数。 |
| `src/watch-policy.mjs`、`src/watcher.mjs` | Windows 只被动挂载，未配置入口报告 `needs-debug-launch`；慢启动不触发关闭；成功连接清除失败冷却；记录 PID、端口和阶段。 |
| `src/debug-port.mjs`、`src/cdp.mjs` | 自动端口模式避让未经验证的监听；固定端口冲突明确报错，不关闭占用者。 |
| `src/service-state.mjs`、`src/doctor.mjs` | 校验后台身份、锁与状态新鲜度，识别 PID 复用；只回收严格验证的本项目旧后台，不处理客户端或其他 Node 程序。 |
| `src/renderer.js` | 从可见输入框所属的已提交 React 树解析真实本地聊天 UUID，支持临时侧栏标识及独立窗口；统一文字中线，使圆环内数字居中，窄窗口保持单行。 |
| `src/cli.mjs` | 按组件源码摘要检测更新，安装后替换旧组件。 |
| `tests/*.test.mjs`、`tests/fixtures/tray-app.cs` | 新增端口、锁、快捷方式备份恢复、新聊天、组件更新，以及真实 Windows 隐藏窗口退出、退出否决、独立后台和参数转义回归。 |

## 验证结果（2026-10-30）

- Windows、Node.js 24.22.1：`npm test` 80 项全部通过，无跳过；包含真实 Windows 快捷方式与生命周期测试。
- 本机 Store 客户端 26.1027.3384.0：`npm run doctor` 确认后台 `alive=true`、`fresh=true`，聊天组件 `mounted=true`、`stale=false`。
- 文字布局在原生组件与窄窗口中测量验证，文字中线一致，圈内数字中心与圆环圆心重合。
- 一次任务栏快捷方式启动观测确认首个主进程已收到调试参数，60 秒内主进程未被替换；该次观测未检测到新鲜挂载，因此不能计作完整启动挂载验收通过。随后独立 doctor 检查确认当前聊天已挂载。当前结果不能证明所有后续任务栏启动都能在 60 秒内挂载。
- 未在本轮重新执行 macOS 实机挂载验收。

## 已知限制及下一步

Store 的原生任务栏虚拟固定项与普通 `.lnk` 不同，不会继承开始菜单链接的参数。需要一次性将其替换为安装器生成的 `%LOCALAPPDATA%\Codex-InfoBar\shortcuts\ChatGPT.lnk` 固定项，并将图标拖回原位置；项目不修改 Explorer 的二进制任务栏配置来强行迁移位置。普通 `.lnk` 可直接维护启动目标。安装器不能保证自动迁移所有 Store 虚拟固定项。

缺少调试参数时，保存工作并完全退出客户端，再通过已配置的图标启动。运行 `npm run doctor` 检查聊天窗口，只有 `mounted=true` 且 `stale=false` 才算当前挂载成功。排查启动问题时同时检查 `watcher.log`、`collector.log`、`watcher-error.log` 和 `status.json`；仍需继续观察真实任务栏启动后的挂载耗时和图标位置。

源码、用户级运行文件及快捷方式是修改范围；官方应用包、凭据和自动压缩配置不在修改范围。卸载命令仍为 `npm run uninstall:service`。
