# DSH Desktop

> 内嵌 **DSH Web GUI** 的 Windows 桌面客户端（Tauri 2）。

DSH Desktop 是一个轻量的 Windows 桌面壳程序：它把 DeepSeek Harness 的 Web 界面（默认 `http://127.0.0.1:3080`）以原生窗口的形式呈现，并提供系统托盘、开机自启动、服务器状态监测等桌面化能力。

## 功能特性

| 特性 | 说明 |
| --- | --- |
| 🖥️ 内嵌 DSH Web GUI | 主窗口直接加载 DSH 网页界面；服务离线时自动显示本地控制台页 |
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
2. Rust 后台线程每 5 秒对 `http://<host>:<port>` 做 TCP 探活，通过 `dsh-status` 事件推送给前端，并同步更新托盘菜单状态。
3. 服务在线且勾选「在线时自动嵌入」时，主窗口导航到 DSH Web GUI 地址，形成原生窗口内嵌体验。
4. 托盘菜单「返回控制台」随时切回本地设置页。

## 环境要求（Windows 构建）

| 依赖 | 说明 |
| --- | --- |
| Windows 10 / 11 | 需要 WebView2 运行时（Win11 自带；Win10 首次运行安装器会自动引导） |
| Node.js 18+ | 前端构建（推荐 LTS：https://nodejs.org） |
| Rust（MSVC 工具链） | Tauri 后端：`rustup default stable-msvc`（https://rustup.rs） |
| VS Build Tools | MSVC 链接器（安装 Rust 时选择 MSVC 工具链通常已就绪） |

## 快速开始（开发模式）

```bash
# 1. 安装前端依赖
npm install

# 2. 启动开发模式（自动打开桌面窗口，前端改动实时热更新）
npm run tauri dev
```

> 开发模式下 Vite 运行在 `http://localhost:1420`，窗口由 Tauri 打开并注入桌面 API。

## 构建安装包（Windows）

方式一：一键脚本（PowerShell）

```powershell
.\build-windows.ps1
```

方式二：手动

```bash
npm install
npm run tauri build
```

产物位置：

```
src-tauri\target\release\bundle\nsis\DSH Desktop_0.1.0_x64-setup.exe   # NSIS 安装包（含中文）
src-tauri\target\release\bundle\msi\DSH Desktop_0.1.0_x64_en-US.msi    # MSI 安装包
```

方式三：GitHub Actions（推送 `v*` 标签或手动触发），自动在 `windows-latest` 上构建并上传产物。

## 使用说明

- **首次运行**：确认 DSH 服务已启动（`http://127.0.0.1:3080`），应用会自动检测并嵌入。
- **修改端口**：设置页修改「主机 / 端口」→ 保存，状态立即重新检测。
- **托盘操作**：
  - 左键单击图标：显示 / 隐藏主窗口；
  - 右键图标：查看在线状态、打开 DSH、返回控制台、开关自启动、退出。
- **退出程序**：必须通过托盘菜单「退出」（关闭窗口只会隐藏到托盘）。

## 配置存储

| 内容 | 位置 |
| --- | --- |
| 连接设置 | `%APPDATA%\com.dsh.desktop\settings.json` |
| 窗口状态 | `%APPDATA%\com.dsh.desktop\.window-state.json`（由插件管理） |
| 开机自启动 | Windows 注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`（由插件管理） |

## 常见问题

**Q：状态一直显示「离线」？**
A：请确认 DSH 服务已启动且端口正确。可在设置页修改端口后保存；也可在浏览器直接访问确认。

**Q：嵌入的 DSH 页面打不开？**
A：DSH 页面需能被 WebView2 访问（`http://127.0.0.1:<port>`）。确认没有代理软件拦截本地回环地址；必要时改用「在浏览器中打开」。

**Q：如何彻底退出？**
A：右键托盘图标 → 退出。

**Q：为什么不直接打包成单个 exe？**
A：NSIS 安装包更符合 Windows 分发习惯（含桌面/开始菜单快捷方式）；MSI 适合企业批量部署。两者均已配置。

## 技术栈

- [Tauri 2](https://tauri.app) — 桌面运行时（Rust + WebView2）
- [Vite 6](https://vite.dev) + TypeScript — 前端
- 插件：`single-instance`、`autostart`、`window-state`、`opener`

## License

MIT
