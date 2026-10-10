import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Tauri 开发时注入 TAURI_ENV_* / TAURI_DEV_HOST 环境变量
const host = process.env.TAURI_DEV_HOST;

/** 把相对于本配置文件的路径转成绝对路径（多页面入口用）。 */
const entry = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  // 防止 Vite 清空 Tauri 输出
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 忽略 Rust 目录，避免重复编译触发
      ignored: ["**/src-tauri/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    // 生产构建目标：Tauri 使用 WebView2 (Chromium)，可安全使用较新的目标
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
    minify: process.env.TAURI_ENV_DEBUG ? false : "esbuild",
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    rollupOptions: {
      input: {
        // 主窗口：本地控制台页（启动时作为占位页加载，就绪后导航到 DSH）
        main: entry("./index.html"),
        // 启动动画：由独立的 splash 窗口加载
        splash: entry("./splash.html"),
      },
    },
  },
});
