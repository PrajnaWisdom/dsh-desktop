# dsh-update-check

轻量的 dsh Web GUI 插件：在设置页显示内置 `@deepseek-ai/dsh` 的当前版本，并查询 npm registry 判断是否有新版。

## 功能

- 设置页新增「检查更新」section，展示当前版本 vs npm 最新版（`dist-tags.latest`）。
- 自动在页面加载时检查一次，也可点「检查」手动刷新。
- npmjs 优先，失败回退 npmmirror；registry 不可达时只显示错误，不影响其它功能。
- 检测到新版本时，显示「前往下载新版」按钮，跳转到
  [PrajnaWisdom/dsh-desktop](https://github.com/PrajnaWisdom/dsh-desktop) 仓库页
  （内置 DSH 随桌面客户端打包发布，通过下载最新安装包完成更新）。

## 组成

- **Host 半区**（`lib/index.js`，exports `.`）：注册 loopback-only 路由
  `GET /api/dsh-update-check/check`，读取已安装 dsh 版本 + 查询 npm registry，
  返回 `{ ok, current, latest, hasUpdate }`。
- **浏览器半区**（`lib/client.js`，exports `./client`）：设置页 section。
- **bundle patch**（`cordis.patch.yml`）：`insert` 插件行 `ui-dsh-update-check`。

## 安装

作为 profile bundle 接入（与 zebbkira 插件同一机制）：

1. 把本包放入 `$DSH_HOME/profiles/web/node_modules/@dsh-desktop/dsh-update-check/`。
2. 在 `profiles/web/package.json` 的 `dependencies` 加入
   `"@dsh-desktop/dsh-update-check": "0.1.0"`，并把
   `"@dsh-desktop/dsh-update-check"` 追加进 `dsh.profile.bundles`。
3. 重启 dsh web。

## 说明

- 版本比较用 `x.y.z` 三段数值（忽略 `-rc.N` 预发布后缀）。
- 内置 dsh 版本读取自
  `$DSH_HOME/profiles/node_modules/@deepseek-ai/dsh/package.json`
  （或 `profiles/web/node_modules/...`）。

## License

MIT
