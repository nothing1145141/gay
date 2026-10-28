@echo off
chcp 65001 >nul
rem ==================================================================
rem  PhotoLab 本地运行（新版 Web UI，开发/即用）
rem
rem  用法：双击运行，或在仓库根目录执行  run.bat
rem        也可带参数透传给 server.py，例如： run.bat --port 8000
rem
rem  首次运行自动创建虚拟环境、装依赖（含可选 rawpy/pyopencl/onnxruntime，
rem  装失败不影响基本功能）、构建前端，然后启动服务端。
rem  就绪后控制台会打出： PHOTOLAB_SERVER_READY http://127.0.0.1:<port> token=...
rem  默认 --no-auth，直接浏览器打开上面的地址即可。
rem ==================================================================
setlocal enabledelayedexpansion
cd /d %~dp0

rem ---- 0. 环境自检 ----
where python >nul 2>nul
if errorlevel 1 (
    echo [错误] 未找到 python，请先安装 Python 3.9+ 并加入 PATH
    pause & exit /b 1
)

rem ---- 1. 虚拟环境 ----
if not exist .venv\Scripts\python.exe (
    echo [初始化] 创建虚拟环境...
    python -m venv .venv
    if errorlevel 1 ( echo [错误] 创建虚拟环境失败 & pause & exit /b 1 )
)

.venv\Scripts\python.exe -c "import fastapi, uvicorn, cv2, numpy" 2>nul
if errorlevel 1 (
    echo [初始化] 安装后端依赖...
    .venv\Scripts\python.exe -m pip install -r requirements.txt
    if errorlevel 1 ( echo [错误] 依赖安装失败，请检查网络后重试 & pause & exit /b 1 )
)

rem ---- 2. 可选依赖：rawpy / pyopencl / onnxruntime（失败静默跳过） ----
for %%p in (rawpy pyopencl onnxruntime) do (
    .venv\Scripts\python.exe -c "import %%p" 2>nul || (
        echo [可选] 安装 %%p ...
        .venv\Scripts\python.exe -m pip install --quiet --disable-pip-version-check %%p >nul 2>&1 || echo [可选] %%p 安装失败，已跳过（不影响基本功能）
    )
)

rem ---- 3. 前端：dist 缺失则构建（需要 npm；缺失则降级为 API-only） ----
if not exist frontend\dist\index.html (
    where npm >nul 2>nul
    if errorlevel 1 (
        echo [警告] 未找到 npm 且前端未构建，将仅启动 API（无 Web UI）。
        echo         如需 Web UI：安装 Node.js 后执行  pushd frontend ^&^& npm install ^&^& npm run build
    ) else (
        echo [初始化] 构建前端（Vue3 + Vite）...
        pushd frontend
        if not exist node_modules (
            call npm install
            if errorlevel 1 ( popd & echo [警告] npm install 失败，将仅启动 API & goto :serve )
        )
        call npm run build
        if errorlevel 1 ( popd & echo [警告] 前端构建失败，将仅启动 API & goto :serve )
        popd
    )
)

:serve
echo.
echo ==========================================================
echo   PhotoLab 服务端启动中... 浏览器打开下面打印的地址
echo ==========================================================
.venv\Scripts\python.exe server.py --no-auth %*
if errorlevel 1 (
    echo [错误] 服务端异常退出
    pause
)
endlocal
