@echo off
setlocal
REM ================================================================
REM 法宝 Excel 转 talisman-db.js —— 开发维护脚本（双击运行）。
REM 依赖 Node.js 与 SheetJS(xlsx)；xlsx 不写入项目 package.json，
REM 而是自动安装到 %TEMP%\xlsx-conv，保持项目零依赖。
REM 用法：直接双击本文件（cmd 以 GBK 解析，勿改为 UTF-8 编码）。
REM 注意：npm/npx 是 npm 生成的 .cmd shim，必须用 call 调用，
REM       否则控制权转移不返回，后续行全部被跳过（表现为闪退）。
REM ================================================================
cd /d "%~dp0"
REM 中文提示（GBK，须在 chcp 65001 之前输出）
if not exist "法宝属性.xlsx" (
    echo [错误] 当前目录找不到 法宝属性.xlsx
    echo        请把本脚本放在项目根目录再运行。
    echo.
    pause
    exit /b 1
)

chcp 65001 >nul

REM 允许用环境变量 XLSX_MODULE_DIR 覆盖默认安装位置
if not defined XLSX_MODULE_DIR set "XLSX_MODULE_DIR=%TEMP%\xlsx-conv"
set "XLSX_DIR=%XLSX_MODULE_DIR%"

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js not found in PATH.
    echo         Please install Node.js LTS from https://nodejs.org and retry.
    echo.
    pause
    exit /b 1
)

REM 就绪检查：以 node_modules\xlsx\package.json 实际存在为准。
REM 旧版误用 package.json 判断——npm init 成功而 install 失败留下的
REM 空 package.json 会导致跳过安装、带着残缺状态直接跑 node。
if exist "%XLSX_DIR%\node_modules\xlsx\package.json" goto run_node

REM ---- 自动安装 xlsx 到临时目录（官方源失败则用 npmmirror 镜像重试） ----
echo [INFO] xlsx module not found, installing to "%XLSX_DIR%" ...
if not exist "%XLSX_DIR%" mkdir "%XLSX_DIR%"
pushd "%XLSX_DIR%"
if not exist package.json call npm init -y >nul

REM 尝试 1：官方 registry
call npm install xlsx --no-fund --no-audit
if not errorlevel 1 goto verify_install

REM 尝试 2：npmmirror 镜像
echo [WARN] install from registry.npmjs.org failed, retrying with npmmirror.com ...
call npm install xlsx --no-fund --no-audit --registry=https://registry.npmmirror.com
if not errorlevel 1 goto verify_install

REM 尝试 3：npx 兜底（官方源）
echo [WARN] npm install failed, trying npx fallback ...
call npx --yes npm install xlsx --no-fund --no-audit
if not errorlevel 1 goto verify_install

REM 尝试 4：npx 兜底（镜像源）
call npx --yes npm install xlsx --no-fund --no-audit --registry=https://registry.npmmirror.com

:verify_install
popd

REM ---- 安装后校验：xlsx 目录必须真的存在，否则明确报错退出 ----
if not exist "%XLSX_DIR%\node_modules\xlsx\package.json" (
    echo.
    echo [ERROR] xlsx auto-install FAILED: "%XLSX_DIR%\node_modules\xlsx" not found.
    echo         Likely cause: network cannot reach npm registry.
    echo         Manual fix, option A - npmmirror mirror:
    echo           PowerShell:  mkdir "$env:TEMP\xlsx-conv" -Force; cd "$env:TEMP\xlsx-conv"; npm install xlsx --registry=https://registry.npmmirror.com
    echo         Manual fix, option B - official registry:
    echo           PowerShell:  mkdir "$env:TEMP\xlsx-conv" -Force; cd "$env:TEMP\xlsx-conv"; npm install xlsx
    echo         Then double-click this script again.
    echo.
    pause
    exit /b 1
)

echo [INFO] xlsx installed successfully.

:run_node
REM 将安装目录传给转换脚本，使其能找到临时安装的 xlsx
set "XLSX_MODULE_DIR=%XLSX_DIR%"

echo [INFO] Running conversion: scripts/convert-excel.mjs
echo.
call node scripts/convert-excel.mjs
if errorlevel 1 (
    echo.
    echo [ERROR] conversion failed, see messages above.
    pause
    exit /b 1
)

echo.
echo [OK] data/talisman-db.js generated successfully.
echo      Please review git diff, then commit manually.
echo.
pause
