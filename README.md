# DSH Desktop

> 内嵌 **DSH Web GUI** 的 Windows 桌面客户端（Tauri 2）。

DSH Desktop 是一个轻量的 Windows 桌面壳程序：它把 DeepSeek Harness 的 Web 界面以原生窗口的形式呈现，
并提供系统托盘、开机自启动、服务状态监测、桌面通知等桌面化能力。

它采用 **Route C「无端口」架构**——内置 DSH 以 Node sidecar 子进程运行，前端通过 `dsh` 自定义协议加载，
**全程不监听任何 TCP 端口**。

## 功能特性

| 特性 | 说明 |
| --- | --- |
| 🖥️ 内嵌 DSH Web GUI | 主窗口通过 `dsh` 自定义协议加载 DSH 页面（Windows 上 origin 为 `http://dsh.localhost`） |
| 🚫 无端口架构 | `/api` 调用走 Tauri 命令 → sidecar stdin/stdout；下行流走 Tauri 事件，不打开任何 socket |
| 📦 完整内置 DSH | 安装包自带 Node 运行时与 `@deepseek-ai/dsh` 包，双击即用、零预装依赖 |
| 🚀 自动拉起 sidecar | 应用启动时自动拉起内置 DSH（独立 DSH_HOME）；异常退出会自动重启（带崩溃循环保护） |
| 🙈 不闪现启动页 | 「就绪后自动进入 DSH」开启时，启动不显示本地控制台页，服务就绪后直接呈现 DSH |
| 📊 状态监测 | 后台每 5 秒刷新 sidecar 状态，托盘菜单与主界面实时显示「就绪 / 启动中 / 离线」 |
| 🗔 系统托盘 | 左键单击显示 / 隐藏窗口；右键菜单：状态、打开 DSH、返回控制台、查看日志、开机自启动、退出 |
| 🔔 桌面通知 | 屏幕右下角置顶无边框通知窗口（8 秒自动关闭，也可手动关闭） |
| 📄 日志 | 托盘「查看日志」直接打开运行日志；sidecar 输出与桌面侧诊断写入同一文件 |
| 🚀 开机自启动 | 托盘菜单或控制台页一键开关（自启动时以 `--hidden` 静默启动） |
| 🧠 窗口状态记忆 | 记住窗口大小与位置（`tauri-plugin-window-state`） |
| 🔂 单实例 | 重复启动时聚焦已有窗口 |
| 🧩 内置插件 | 随包分发两个 DSH Web GUI 插件：更新检查、Skills & MCP 管理 |

> ⚙️ 设置中保留的 `host` / `port` 字段仅为历史兼容与展示，Route C 已不再使用端口。

## 目录结构

```
dsh-desktop/
├── index.html                     # 本地控制台页（壳界面 / 设置页）
├── src/
│   ├── main.ts                    # 前端逻辑：状态渲染、设置、自动进入 DSH
│   └── styles.css                 # 深色主题样式
├── sidecar/                       # Route C stdio sidecar（Node，随包分发）
│   ├── main.js                    # 入口：JSON-lines 协议分发
│   ├── boot.js                    # 在进程内启动 dsh 的 `web` profile
│   ├── carrier.js                 # webServer 形状的路由注册表（替代 node:http）
│   ├── bridge-client.js           # 注入 DSH 页面的渲染端桥接脚本
│   ├── dsh-update-check/          # 内置插件：检查 DSH 更新
│   └── dsh-skills-mcp-manager/    # 内置插件：Skills & MCP 管理
├── src-tauri/
│   ├── src/lib.rs                 # Rust 后端：托盘、启动流程、设置、状态轮询
│   ├── src/sidecar.rs             # sidecar 子进程管理与线协议
│   ├── src/bridge.rs              # `dsh` 自定义协议 + 渲染端桥接命令
│   ├── src/notify.rs              # 右下角桌面通知窗口
│   ├── tauri.conf.json            # Tauri 配置（窗口 / 打包 / 资源 / CSP）
│   ├── capabilities/              # 前端权限声明
│   ├── resources/                 # 打包资源：node/、dsh/（由 CI 填充）、sidecar/
│   └── icons/                     # 应用图标（由 `tauri icon` 生成）
├── scripts/gen_icon.py            # 图标源图生成脚本（Pillow）
├── build-windows.ps1              # Windows 一键构建脚本
└── .github/workflows/             # GitHub Actions 自动打包（完整内置版）
```

## 工作原理

1. 主窗口以 `visible: false` 创建。若「应用启动时自动启动内置 DSH」（默认开）与「就绪后自动进入 DSH」
   （默认开）同时开启，窗口会保持隐藏，避免闪现控制台页。
2. Rust 后台拉起 sidecar：

   ```
   node.exe <DSH_HOME>/profiles/node_modules/@dsh-desktop/sidecar/main.js \
            --home <DSH_HOME> --anchor <dsh>/node_modules/@deepseek-ai/dsh/package.json
   ```

   使用独立 `DSH_HOME`（`%APPDATA%\com.dsh.desktop\dsh-home`），
   stderr 经管道读回 Rust，与桌面侧诊断一起写入 `%APPDATA%\com.dsh.desktop\sidecar.log`（按大小轮转）。
3. sidecar 在**进程内**启动 dsh 的 `web` profile——真正的 WebServer（`createServer` + `listen`）
   被一个不监听端口的 shim 替换，其余组合层不变。启动完成后在 stdout 发一行 `{"t":"ready",...}`，
   Rust 侧最长等待 90 秒。
4. 通信协议（stdin/stdout JSON-lines）：
   - **上行**：`/api` 请求经 Tauri 命令（`dsh_rpc`）或 `dsh` 协议处理器写入 sidecar stdin；
   - **下行**：`response` 行 + 长度前缀分帧的原始 body；订阅流以 `frame` / `end` 消息经
     Tauri 事件（`dsh-frame` / `dsh-stream-end`）推给渲染端。
5. sidecar 就绪后，主窗口导航到 `http://dsh.localhost/` 并显示；若启动失败，则显示控制台页便于排查。
6. 后台线程每 5 秒刷新一次状态（进程存活 + ready 标记），更新托盘菜单文本并推送 `dsh-status` 事件。
7. sidecar 意外退出时自动重启（延迟 3 秒）；若两次重启间隔小于 5 秒则停止自动重启，避免崩溃循环。
8. 托盘「返回控制台」随时切回本地设置页；「查看日志」直接打开运行日志。

## 环境要求（Windows 构建）

| 依赖 | 说明 |
| --- | --- |
| Windows 10 / 11 | 需要 WebView2 运行时（Win11 自带；Win10 首次运行安装器会自动引导） |
| Node.js 18+ | 仅**开发者**需要（构建工具链）；最终用户无需安装 |
| Rust（MSVC 工具链，≥ 1.77.2） | 仅**开发者**需要；最终用户无需安装 |
| VS Build Tools | MSVC 链接器（安装 Rust 时选择 MSVC 工具链通常已就绪） |
| Windows SDK | 提供 `rc.exe`；缺失时 `tauri-build` 会报 `Are you sure you have RC.EXE in your $PATH` |

> 完整内置版把 Node 运行时（当前 24.12.0）与 dsh 包（当前 0.2.0-rc.2）都打进了安装包，**最终用户零依赖**。

## 快速开始（开发模式）

```bash
# 1. 安装前端依赖
npm install

# 2. 启动开发模式（自动打开桌面窗口，前端改动实时热更新）
npm run tauri dev
```

> 开发模式下 Vite 运行在 `http://localhost:1420`，窗口由 Tauri 打开并注入桌面 API。

> ⚠️ 开发模式默认**没有内置 DSH 资源**（`src-tauri/resources/node` 与 `resources/dsh` 不入库）。
> 需要跑通完整链路时，可用环境变量指向本地已有的 Node 与 dsh：
> `DSH_DESKTOP_NODE=<node.exe 路径>`、`DSH_DESKTOP_SIDECAR_SRC=<仓库 sidecar 目录>`。

## 构建安装包（Windows）

> **完整内置版（含 Node + dsh）请交给 GitHub Actions 在 `windows-latest` 上构建**——
> dsh 含 `node-pty`、`sharp` 等平台原生模块，必须在 Windows 环境重新安装才能拿到
> Windows 版二进制。推送 `v*` 标签或手动 `workflow_dispatch` 触发即可；CI 会下载 Node 运行时、
> 安装并校验 dsh 包（含渲染链子包版本一致性检查）、执行 `tauri build`，
> 打标签时还会自动创建 GitHub Release。

方式一：一键脚本（PowerShell）

```powershell
.\build-windows.ps1
```

方式二：手动

```bash
npm install
npm run tauri build
```

产物位置（版本号跟随 `tauri.conf.json`）：

```
src-tauri\target\release\bundle\nsis\DSH Desktop_0.4.30_x64-setup.exe   # NSIS 安装包（简体中文 / English）
```

方式三：GitHub Actions（推荐，完整内置版）。

> ⚠️ 本地构建出的安装包**不含** Node 运行时与 dsh 本体，安装后无法启动内置 DSH，
> 仅供开发调试与界面预览；正式分发请使用 CI 产物。

## 使用说明

- **首次运行**：内置版开箱即用——应用会自动拉起内置 DSH（首次约 5–15 秒自举），就绪后直接进入 DSH。
- **启动行为**：勾选「就绪后自动进入 DSH」时启动不显示控制台页；取消勾选则启动后停留在控制台页，可手动点「打开 DSH（嵌入窗口）」。
- **内置服务管理**：控制台页可「启动内置 DSH」「停止内置 DSH」「打开运行日志」；取消勾选「应用启动时自动启动内置 DSH」后需手动启动。
- **查看日志**：托盘右键 →「查看日志」，或控制台页「打开运行日志」。日志文件同时包含 sidecar 输出与桌面侧诊断。
- **托盘操作**：
  - 左键单击图标：显示 / 隐藏主窗口；
  - 右键图标：查看状态、打开 DSH、返回控制台、查看日志、开关开机自启动、退出。
- **退出程序**：必须通过托盘菜单「退出」（关闭窗口只会隐藏到托盘；退出时内置 DSH 一并停止）。

## 配置存储

| 内容 | 位置 |
| --- | --- |
| 连接 / 启动设置 | `%APPDATA%\com.dsh.desktop\settings.json`（`host`/`port` 为历史字段；实际生效的是 `auto_start_server`、`auto_open`） |
| 内置 DSH 数据（DSH_HOME） | `%APPDATA%\com.dsh.desktop\dsh-home`（独立于系统 `~/.dsh`） |
| 运行日志（sidecar + 桌面诊断） | `%APPDATA%\com.dsh.desktop\sidecar.log`（超过 4MB 自动轮转，保留 `sidecar.log.1` ~ `.3`） |
| 窗口状态 | `%APPDATA%\com.dsh.desktop\.window-state.json`（由插件管理） |
| 开机自启动 | 注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`（由插件管理） |

## 常见问题

**Q：状态一直显示「离线」？**
A：说明内置 DSH 没有起来。先点托盘「查看日志」（或控制台页「打开运行日志」）看 `sidecar.log`；
常见原因是安装包缺少内置资源（例如用了本地构建的包）或安全软件拦截。可再点「启动内置 DSH」重试。

**Q：内置 DSH 首次启动要多久？**
A：首次启动约 5–15 秒（需要初始化 `DSH_HOME` 的 profile 并建立插件链接，使用 NTFS junction，无需管理员权限）；之后通常在数秒内。

> 如果每次启动都明显偏慢，多半是**插件或 MCP server 拖的**：例如在 profile 里用
> `command: npx, args: ["-y", "..."]` 拉起 MCP server，`npx` 每次都要做 npm 解析，
> 在 Windows 上实测可达 **8 秒**，而改成 `command: node` 直指包内入口只要 **不到 1 秒**。
> 日志每行都带 `[+Nms]` 前缀，可以直接看出时间花在哪一段。

**Q：内置服务的数据和系统里已有 dsh 的数据冲突吗？**
A：不冲突。内置版使用独立的 `DSH_HOME`（`%APPDATA%\com.dsh.desktop\dsh-home`）。首次使用时需在 Web 界面里重新配置模型凭据。

**Q：会占用端口吗？**
A：不会。Route C 架构下 sidecar 只在 stdin/stdout 上跑 JSON-lines 协议，不打开任何 socket。

**Q：内置服务启动失败怎么办？**
A：在控制台页点「打开运行日志」查看 `sidecar.log`；日志末尾通常带有 `[diag]` / `[desktop]` 前缀的退出原因或启动失败信息。

**Q：如何彻底退出？**
A：右键托盘图标 → 退出（内置 DSH 随之停止）。

**Q：为什么不直接打包成单个 exe？**
A：NSIS 安装包更符合 Windows 分发习惯（含桌面 / 开始菜单快捷方式）；完整内置版体积较大（Node 运行时 + dsh 包），MSI 承载此类负载不稳定，故仅产出 NSIS。

## 技术栈

- [Tauri 2](https://tauri.app) — 桌面运行时（Rust + WebView2）
- [Vite 6](https://vite.dev) + TypeScript — 前端（本地控制台页）
- Node.js — Route C sidecar 运行时（随包内置）
- Tauri 插件：`single-instance`、`autostart`、`window-state`、`opener`
- Rust 侧不引入日志框架：sidecar 的 stderr 经管道读回 Rust，与桌面侧诊断（`Sidecar::append_log()`）
  一起写入 `sidecar.log`；写入器自带按大小轮转，并给每行加上相对本次启动的 `[+Nms]` 耗时前缀

## License

MIT
