# Windows 修复说明（v0.3.2）

v0.3.2 主要修复客户端升级后丢失挂载、退出后首次点击未能打开、登录入口竞争，以及启动时任务栏暂时出现两个按钮的问题。修改在项目源码和用户级安装中实现，不修改官方应用包、签名、凭据、压缩设置或系统策略。

## 问题与修复

| 触发场景 | 原因与处理 |
| --- | --- |
| Codex 升级后图标仍指向旧版本目录 | 固定原生启动器每次查询当前用户注册的官方包，读取现有端口，再通过 Windows 包接口激活；普通版本目录变化无需更换图标。 |
| 更新只重置快捷方式应用标识或重新启动属性 | 识别已知官方默认属性的重置并恢复；Explorer 时间戳变化不再误判为用户编辑，真正自定义参数、图标、热键及外来应用标识仍保留。 |
| 登录后已有无调试实例，之后点图标仍无状态条 | 官方 MSIX 登录任务可能绕过启动器。安装器从当前清单读取任务 ID（当前为 App），备份用户启用状态，再统一由 InfoBar 登录入口处理。 |
| 关闭窗口后立即点图标，第一次没有留下新窗口 | 旧进程可能仍在退出。无可用主窗口时等待它自然结束，再完成同一次启动；正常已有窗口直接唤起，避免无条件创建第二个客户端。 |
| 客户端报告缺少包身份或无法建立 Windows restart lifecycle | 固定启动器通过 IApplicationActivationManager 激活官方包并传入调试参数，保留包身份；诊断记录实际 PackageFamily。 |
| 启动后多一个任务栏按钮，约十秒后才合并 | 固定图标与初始窗口的应用标识暂时不同。原生启动器在窗口创建/显示阶段同步标识，100ms 扫描和后台轮询兜底。 |
| 已有无调试进程，不能在运行中补加参数 | 提供默认取消的保存确认；仅用户明确确认后正常退出并重新打开，客户端否决、超时或身份变化均停止。 |

Windows 用显式 AppUserModelID 关联窗口与任务栏按钮；修改窗口标识会触发 Shell 重新分组，重新启动命令等属性应先写入。参考 [Microsoft AppUserModelID 文档](https://learn.microsoft.com/en-us/windows/win32/properties/props-system-appusermodel-id)。

## 本次修改位置

| 文件 | 修改内容 |
| --- | --- |
| src/windows-launcher.cs、src/windows-launcher.mjs | 固定原生启动器、版本/端口查询、包激活、官方包身份检查、进程复用、退出衔接、并发激活串行化、后台补启动及实际激活日志。 |
| src/windows-native.cs | 正常退出增加预期创建时间校验；使用 Restart Manager 零强制标志，尊重客户端拒绝。 |
| src/windows-shell.cs、src/windows-shell.mjs | 快捷方式与窗口的任务栏标识和重新启动属性；按路径、PID、创建时间校验，保存/导入原属性并在卸载时恢复。 |
| src/windows-window-bootstrap.cs | 包激活前启动进程外窗口事件监听，在窗口创建/显示时提前同步标识；修改前持久化原值，不向客户端注入代码。 |
| src/windows-startup.mjs | 从清单定位官方登录任务，备份/停用直接启动入口，保留自动打开偏好；按包族跨版本维护，尊重系统策略并支持卸载恢复。 |
| src/windows-shortcuts.mjs | 维护原有普通链接、独立应用标识和官方图标；恢复默认属性重置，保护用户修改，清理继承的 Toast 激活标识，通知 Shell 刷新。 |
| src/install.mjs、src/watcher.mjs | 安装和维护启动器、登录入口及窗口路由；后台被动挂载，不自动关闭客户端，增加新进程来源日志。 |
| src/doctor.mjs、src/cdp.mjs | 检查官方直接登录入口、实际调试状态、服务新鲜度和原生挂载，说明已有进程不能补加启动参数。 |
| tests/windows-*.test.mjs | 包查询、自然退出、窗口复用、确认/拒绝退出、链接重建、登录任务备份恢复、早期窗口分组及卸载回归。 |
| README.md、docs/AUTO_INSTALL_PROMPT.md、CHANGELOG.md | 更新安装方法、版本说明、修改位置和兼容性边界，区分两平台启动行为。 |

## 安装与登录方式

```powershell
npm test
npm run install:service
npm run doctor
```

Node.js 要求 22.17+。安装器默认保留原有是否登录后自动打开 Codex 的偏好，也可显式指定：

```powershell
npm run install:service -- --windows-login=launch
npm run install:service -- --windows-login=manual
```

launch 表示登录时通过固定启动器打开 Codex；manual 仅启动后台，等待点击原图标。登录激活不会弹出恢复确认或关闭已有客户端。官方任务原状态先备份，卸载时恢复；系统策略不会被覆盖，用户后续不同的设置也会保留。

固定启动目标为 %LOCALAPPDATA%\Codex-InfoBar\launcher\CodexInfoBarLauncher.exe。现有普通桌面、开始菜单和任务栏 .lnk 会原位维护，保留可见名称和文件位置。仅有 Store 虚拟应用身份、没有可管理普通 .lnk 的固定项仍有一次性迁移限制，安装器不能保证迁移所有此类固定项或保留其排序。

安装始终保护当前 Codex。已有无调试实例时先保存工作并完全退出，再使用受管理图标，或在启动器确认窗口明确选择允许正常重开；不存在每次启动都必须重开一次的设计。

## 验证范围

- Windows / Node.js 24.22.1：106 项回归全部通过，无失败、无跳过。
- Store 客户端 26.1103.3517.0：实际原任务栏首次启动已验证调试参数、官方包身份、当前聊天 mounted=true / stale=false，以及超过 60 秒无进程替换。
- 已有窗口通过固定链接激活时，客户端 PID 保持，启动器没有请求创建第二个进程；实际登录入口在已登录会话中执行验证成功。
- 早期分组回归使用真实隔离原生窗口，捕获时窗口尚未显示，保存原属性到写入新属性耗时约 15ms；后台正确导入原始备份，卸载恢复未关闭测试客户端。这不是对真实客户端启动耗时的承诺。
- 退出衔接使用隔离原生进程覆盖；另一次真实快速重开未捕获旧进程仍存的瞬间，不能将该次检查计为退出竞争的实机复现。
- 连续版本和默认链接重建使用隔离目录模拟，没有为验证而升级、降级或卸载官方客户端。
- 下一次真实官方升级、Windows 注销后登录，以及早期分组修复后的真实冷启动仍待验证。当前版本未重新进行 macOS 实机挂载验收；CI 运行 macOS / Windows 与 Node 22 / 24，结果以 Actions 为准。

## 限制与诊断

进程外窗口事件为异步通知，不能保证 Windows 最初绘制时绝无一帧临时按钮，尤其是系统自身拥有的启动画面。修复目标是去掉通常约十秒的后台等待。参考 [SetWinEventHook](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwineventhook)。

固定启动器只覆盖受管理入口。官方更新器、协议链接或其他入口仍可能先打开无调试实例；运行中无法为它补加启动参数，也不会为此强制结束它。未来包身份、调试接口或页面结构发生不兼容变化时可能仍需更新 InfoBar。非 Store 安装暂未支持。

用户数据目录为 %LOCALAPPDATA%\Codex-InfoBar，重点检查：

- launcher.log、launcher-status.json：实际激活、进程复用及 PackageFamily。
- watcher.log、collector.log、watcher-error.log、status.json：后台、采集和连接状态。
- shortcuts.json、shell-windows.json、shell-bootstrap：链接及窗口属性备份。
- startup-routing.json、settings.json：官方登录任务原状态与托管登录偏好。

只有当前聊天 mounted=true 且 stale=false 才计为新鲜原生挂载；辅助窗口、旧缓存、浏览器预览或单独写入启动项均不能证明挂载成功。

```powershell
npm run uninstall:service
```

卸载移除 InfoBar 登录服务，恢复仍由本项目管理的链接、窗口属性及官方登录任务，保留运行文件、日志和缓存。不会强制终止 Codex。正常完全退出并重新打开客户端后，本次调试端口才会关闭。
