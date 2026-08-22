@echo off
cd /d "%~dp0"

rem ============================================================
rem publish-to-vercel.bat -- 一键发布本站到 Vercel 生产环境
rem
rem 用途：把 backpack-arrangement-tool 静态站点发布到 Vercel
rem       生产环境。生产 URL：
rem       https://backpack-arrangement-tool.vercel.app
rem
rem 前置条件：
rem   1. 已安装 Node.js。
rem   2. 首次发布需先登录 Vercel：vercel login
rem   3. 若项目尚未链接，即工作区无 .vercel\ 目录，
rem      vercel --prod 会交互式询问账号与项目，按提示选择即可。
rem
rem 发布前建议：先运行 convert-talisman-db.bat 确保法宝数据最新，
rem   并确认转换输出为「0 条被拒」。
rem
rem 说明：本文件为 GBK 编码。cmd 解析 UTF-8 中文 bat 有已知缺陷，
rem   会把注释片段当命令执行，故仅在运行 vercel 前才 chcp 65001，
rem   此前保持默认 936 代码页显示中文提示。
rem ============================================================

rem ---- 检查 Node.js ----
where node >nul 2>&1
if errorlevel 1 echo [错误] 未找到 Node.js，请先安装 Node.js 再试。 & pause & exit /b 1

rem ---- 检查 Vercel CLI：优先全局安装，其次 npx 兜底 ----
where vercel >nul 2>&1
if not errorlevel 1 echo 已检测到全局安装的 Vercel CLI。
if errorlevel 1 echo 未检测到全局 Vercel CLI，尝试 npx 兜底……
if errorlevel 1 npx --yes vercel --version >nul 2>&1
if errorlevel 1 echo [错误] Vercel CLI 不可用。 & echo 安装方式一：npm i -g vercel & echo 安装方式二：确保 npx 可用后重跑本脚本，将自动改用 npx --yes vercel --prod & pause & exit /b 1

set "VERCEL_CMD="
where vercel >nul 2>&1
if not errorlevel 1 set "VERCEL_CMD=vercel"
if errorlevel 1 set "VERCEL_CMD=npx --yes vercel"

rem ---- 发布前提示，中文提示保持默认 936 代码页 ----
echo.
echo 提示：发布前建议先运行 convert-talisman-db.bat 确保法宝数据最新，并确认「0 条被拒」。
echo 本次将发布到 Vercel 生产环境：https://backpack-arrangement-tool.vercel.app
echo 若尚未登录 Vercel，请先在命令行执行：vercel login
echo.

rem ---- 切换 UTF-8 代码页后再运行 vercel，其输出可能含中文 ----
chcp 65001 >nul

rem ---- 执行发布。不给 vercel 加 --yes，首次链接项目需交互确认 ----
%VERCEL_CMD% --prod
if errorlevel 1 echo. & echo [ERROR] deploy failed, see messages above. First-time use may need: vercel login & pause & exit /b 1

echo.
echo [OK] deploy finished. See the production URL above.
pause
