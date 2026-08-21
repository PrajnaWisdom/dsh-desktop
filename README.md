# DSH Desktop

> 内嵌 **DSH Web GUI** 的 Windows 桌面客户端（Tauri 2）。

DSH Desktop 是一个轻量的 Windows 桌面壳程序：它把 DeepSeek Harness 的 Web 界面（默认 `http://127.0.0.1:3080`）以原生窗口的形式呈现，并提供系统托盘、开机自启动、服务器状态监测等桌面化能力。

## 功能特性

| 特性 | 说明 |
| --- | --- |
| 🖥️ 内嵌 DSH Web GUI | 主窗口直接加载 DSH 网页界面；服务离线时自动显示本地控制台页 |
| 📦 完整内置 DSH | 安装包自带 Node 运行时与 `@deepseek-ai/dsh` 包，双击即用、零预装依赖 |
| 🚀 自动拉起服务 | 应用启动时自动运行内置 DSH（`--no-open`、独立 DSH_HOME），端口被占用时自动复用 |
| 📊 状态监测 | 每 5 秒 TCP 探活，托盘菜单与主界面实时显示「在线 / 离线」 |
| 🗔 系统托盘 | 关闭窗口隐藏到托盘；左键单击托盘图标 显示/隐藏 窗口 |
| 🚀 开机自启动 | 托盘菜单或设置页一键开关（自启动时以 `--hidden` 静默启动） |
| 🧠 窗口状态记忆 | 记住窗口大小与位置（`tauri-plugin-window-state`） |
| 🔂 单实例 | 重复启动时聚焦已有窗口 |
| ⚙️ 可配置端口 | 连接地址可在设置页修改并持久化 |
| 🌐 浏览器打开 | 一键在系统默认浏览器中打开 DSH 页面 |

## 目录结构

```
dsh-desktop/
├── index.html                 # 本地控制台页（壳界面）
├── src/
│   ├── main.ts                # 前端逻辑：状态渲染、设置、自动嵌入
│   └── styles.css             # 深色主题样式
├── src-tauri/
│   ├── src/lib.rs             # Rust 后端：托盘、探活、命令、导航
│   ├── tauri.conf.json        # Tauri 配置（窗口、打包、CSP）
│   ├── capabilities/          # 前端权限声明
│   └── icons/                 # 应用图标（由 tauri icon 生成）
├── scripts/gen_icon.py        # 图标源图生成脚本（Pillow）
├── build-windows.ps1          # Windows 一键构建脚本
└── .github/workflows/         # GitHub Actions 自动打包
```

## 工作原理

1. 应用启动后加载**本地控制台页**（Tauri 自带 WebView）。
2. 若「应用启动时自动启动内置 DSH」开启（默认），Rust 后台检查目标端口：
   - 端口已被占用 → 直接复用（例如你已自行运行 `dsh web`）；
   - 端口空闲且安装包内置了资源 → 以
     `node.exe <内置>/dsh/lib/bin.js web --no-open --port <端口>` 拉起服务，
     使用独立的 `DSH_HOME`（`%APPDATA%\com.dsh.desktop\dsh-home`），日志写入
     `%APPDATA%\com.dsh.desktop\server.log`；
   - 等待端口就绪（最长 90 秒），应用退出时用 `taskkill /T` 终止整个进程树。
3. Rust 后台线程每 5 秒对 `http://<host>:<port>` 做 TCP 探活，通过 `dsh-status` 事件推送给前端，并同步更新托盘菜单状态。
4. 服务在线且勾选「在线时自动嵌入」时，主窗口导航到 DSH Web GUI 地址，形成原生窗口内嵌体验。
5. 托盘菜单「返回控制台」随时切回本地设置页。

## 环境要求（Windows 构建）

| 依赖 | 说明 |
| --- | --- |
| Windows 10 / 11 | 需要 WebView2 运行时（Win11 自带；Win10 首次运行安装器会自动引导） |
| Node.js 18+ | 仅**开发者**需要（构建工具链）；最终用户无需安装 |
| Rust（MSVC 工具链） | 仅**开发者**需要；最终用户无需安装 |
| VS Build Tools | MSVC 链接器（安装 Rust 时选择 MSVC 工具链通常已就绪） |

> 完整内置版把 Node 运行时和 dsh 包都打进了安装包，**最终用户零依赖**。

## 快速开始（开发模式）

```bash
# 1. 安装前端依赖
npm install

# 2. 启动开发模式（自动打开桌面窗口，前端改动实时热更新）
npm run tauri dev
```

> 开发模式下 Vite 运行在 `http://localhost:1420`，窗口由 Tauri 打开并注入桌面 API。

## 构建安装包（Windows）

> **完整内置版（含 Node + dsh）只能由 GitHub Actions 在 `windows-latest` 上构建**——
> dsh 含 `node-pty`、`sharp` 等平台原生模块，必须用 Windows 环境重新安装才能拿到
> Windows 版二进制。推送 `v*` 标签即触发（工作流会下载 Node 运行时、`npm install` dsh
> 包、预置资源后执行 `tauri build`）。

方式一：一键脚本（PowerShell，构建**外置壳版本**，不含 dsh 本体）

```powershell
.\build-windows.ps1
```

方式二：手动（外置壳版本）

```bash
npm install
npm run tauri build
```

产物位置：

```
src-tauri\target\release\bundle\nsis\DSH Desktop_0.2.1_x64-setup.exe   # NSIS 安装包（含中文）
```

方式三：GitHub Actions（推荐，完整内置版）——推送 `v*` 标签或手动触发，自动构建并上传产物。

> 外置壳版本也能正常使用：它会自动拉起你**系统里已安装的** dsh（`dsh web`），
> 或在「连接设置」中指向任何已运行的 DSH 服务；只是安装包不带 Node 与 dsh 本体。

## 使用说明

- **首次运行**：内置版开箱即用——应用会自动拉起内置 DSH 服务（首次约 5–15 秒自举），就绪后自动嵌入。
- **修改端口**：设置页修改「主机 / 端口」→ 保存，状态立即重新检测（内置服务会以新端口启动）。
- **内置服务管理**：控制台页可「启动 / 停止内置服务」「打开服务器日志」；取消勾选「应用启动时自动启动」后需手动启动。
- **托盘操作**：
  - 左键单击图标：显示 / 隐藏主窗口；
  - 右键图标：查看在线状态、打开 DSH、返回控制台、开关自启动、退出。
- **退出程序**：必须通过托盘菜单「退出」（关闭窗口只会隐藏到托盘；退出时内置 DSH 服务一并停止）。

## 配置存储

| 内容 | 位置 |
| --- | --- |
| 连接设置 | `%APPDATA%\com.dsh.desktop\settings.json` |
| 内置 DSH 数据（DSH_HOME） | `%APPDATA%\com.dsh.desktop\dsh-home`（独立于系统 `~/.dsh`） |
| 内置 DSH 日志 | `%APPDATA%\com.dsh.desktop\server.log` |
| 窗口状态 | `%APPDATA%\com.dsh.desktop\.window-state.json`（由插件管理） |
| 开机自启动 | 注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`（由插件管理） |

## 常见问题

**Q：状态一直显示「离线」？**
A：请确认 DSH 服务已启动且端口正确。内置版可点「启动内置服务」；也可在设置页修改端口后保存，或直接在浏览器访问确认。

**Q：内置 DSH 首次启动要多久？**
A：首次启动约 5–15 秒（需要初始化 `DSH_HOME` 的 profile 并建立插件链接，使用 NTFS junction，无需管理员权限）；之后约 1–3 秒。

**Q：内置服务的数据和系统里已有 dsh 的数据冲突吗？**
A：不冲突。内置版使用独立的 `DSH_HOME`（`%APPDATA%\com.dsh.desktop\dsh-home`）。首次使用时需在 Web 界面里重新配置模型凭据。

**Q：内置服务启动失败怎么办？**
A：在「内置 DSH 服务」卡片点「打开服务器日志」查看 `server.log`；常见原因是端口被占用（此时应用会自动复用已有服务）或安全软件拦截。

**Q：如何彻底退出？**
A：右键托盘图标 → 退出（内置 DSH 服务随之停止）。

**Q：为什么不直接打包成单个 exe？**
A：NSIS 安装包更符合 Windows 分发习惯（含桌面/开始菜单快捷方式）；完整内置版体积约 350MB（Node 运行时 + dsh 包），MSI 承载此类负载不稳定，故仅产出 NSIS。

## 技术栈

- [Tauri 2](https://tauri.app) — 桌面运行时（Rust + WebView2）
- [Vite 6](https://vite.dev) + TypeScript — 前端
- 插件：`single-instance`、`autostart`、`window-state`、`opener`

## License

MIT
