@echo off
cd /d "%~dp0"

rem ============================================================
rem convert-talisman-db.bat -- 法宝数据一键转换（xlsx --^> data\talisman-db.js）
rem
rem 用法：双击运行本文件即可。
rem   1. 新增/修改法宝后，请先保存 Excel（法宝属性.xlsx）并关闭 Excel，再运行本文件。
rem   2. 运行结束后请阅读「转换报告」，确认「0 条被拒」。
rem   3. 刷新页面即可生效。
rem
rem 依赖：Node.js；SheetJS(xlsx) 缺失时会自动安装到 %TEMP%\xlsx-conv。
rem 编码说明：本文件为 GBK 编码。cmd 解析 UTF-8 中文 bat 存在已知缺陷，
rem   故 chcp 65001 放在运行 node 之前，其后只允许出现 ASCII 行。
rem ============================================================

rem ---- 检查 Node.js ----
where node >nul 2>&1
if errorlevel 1 echo [错误] 未找到 Node.js，请先安装 Node.js 后重试。 & pause & exit /b 1

rem ---- 检查 SheetJS(xlsx)，缺失则自动安装到 %TEMP%\xlsx-conv ----
if exist "%TEMP%\xlsx-conv\node_modules\xlsx" echo SheetJS(xlsx) 已就绪。
if not exist "%TEMP%\xlsx-conv\node_modules\xlsx" echo 未检测到 SheetJS(xlsx)，正在自动安装到 %TEMP%\xlsx-conv ...
if not exist "%TEMP%\xlsx-conv" mkdir "%TEMP%\xlsx-conv"
pushd "%TEMP%\xlsx-conv"
if not exist "node_modules\xlsx" call npm install xlsx --no-fund --no-audit
if not exist "node_modules\xlsx" echo [错误] SheetJS 安装失败，请检查网络或 npm 配置后重试。 & popd & pause & exit /b 1
popd

rem ---- 切换 UTF-8 代码页后执行转换（其后均为 ASCII 行）----
chcp 65001 >nul
set "XLSX_MODULE_DIR=%TEMP%\xlsx-conv"
node scripts\convert-excel.mjs
if errorlevel 1 echo. & echo [ERROR] conversion failed, see messages above.

pause
