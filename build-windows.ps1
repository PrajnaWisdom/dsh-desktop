# ============================================================
#  DSH Desktop — Windows 一键构建脚本
#  用法: 在 PowerShell 中执行  .\build-windows.ps1
#  前置要求:
#    - Node.js 18+   (https://nodejs.org)
#    - Rust (MSVC 工具链)  (https://rustup.rs)
#    - WebView2 运行时（Win11 自带，Win10 通常已内置或自动安装）
# ============================================================

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "==> 检查 Node.js ..." -ForegroundColor Cyan
node --version
if ($LASTEXITCODE -ne 0) {
    throw "未找到 Node.js，请先安装: https://nodejs.org (LTS 版本)"
}

Write-Host "`n==> 检查 Rust ..." -ForegroundColor Cyan
cargo --version
if ($LASTEXITCODE -ne 0) {
    throw "未找到 Rust，请先安装: https://rustup.rs (选择 MSVC 工具链)"
}
rustup target list --installed | Select-String "windows-msvc"
if (-not $?) {
    Write-Host "提示: 请确认安装了 x86_64-pc-windows-msvc 目标 (rustup target add x86_64-pc-windows-msvc)"
}

Write-Host "`n==> 安装前端依赖 (npm install) ..." -ForegroundColor Cyan
npm install
if ($LASTEXITCODE -ne 0) { throw "npm install 失败" }

Write-Host "`n==> 构建并打包 (tauri build) ..." -ForegroundColor Cyan
npm run tauri build
if ($LASTEXITCODE -ne 0) { throw "tauri build 失败" }

Write-Host "`n============================================================" -ForegroundColor Green
Write-Host " 构建完成！安装包位于:" -ForegroundColor Green
Write-Host "   NSIS: src-tauri\target\release\bundle\nsis\DSH Desktop_0.2.0_x64-setup.exe"
Write-Host "============================================================" -ForegroundColor Green
Write-Host ""
Write-Host " 提示：本脚本构建的是【外置壳版本】（不含 dsh 本体）。" -ForegroundColor Yellow
Write-Host " 完整内置版（含 Node + dsh）请推送 v* 标签触发 GitHub Actions 构建，" -ForegroundColor Yellow
Write-Host " 或参考 README.md 的「构建安装包」一节。" -ForegroundColor Yellow
