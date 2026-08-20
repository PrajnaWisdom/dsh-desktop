import { defineConfig } from "vite";

// Tauri 开发时注入 TAURI_ENV_* / TAURI_DEV_HOST 环境变量
const host = process.env.TAURI_DEV_HOST;

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
  },
});
