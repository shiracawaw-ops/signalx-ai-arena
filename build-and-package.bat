@echo off
setlocal EnableDelayedExpansion

echo ============================================================
echo  SignalX AI Arena -- Windows Build ^& Package
echo ============================================================
echo.

REM -- Check pnpm is available ------------------------------------------
where pnpm >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo ERROR: pnpm not found. Install it with:
    echo   npm install -g pnpm@latest
    exit /b 1
)

REM -- Install dependencies -----------------------------------------------
echo [1/3] Installing dependencies...
pnpm install --frozen-lockfile
if %ERRORLEVEL% neq 0 (
    echo ERROR: pnpm install failed.
    exit /b 1
)
echo.

REM -- Build frontend (Electron mode) + API server bundle ----------------
echo [2/3] Building frontend and API server...
pnpm run build:electron
if %ERRORLEVEL% neq 0 (
    echo ERROR: build:electron failed.
    exit /b 1
)
echo.

REM -- Package with electron-builder -------------------------------------
echo [3/3] Packaging Windows installer and portable EXE...
npx electron-builder --win --config electron-builder.yml
if %ERRORLEVEL% neq 0 (
    echo ERROR: electron-builder failed.
    exit /b 1
)
echo.

REM -- Done --------------------------------------------------------------
echo ============================================================
echo  Build complete!
echo  Output: artifacts\electron\dist-app\
echo ============================================================
echo.

dir /b "artifacts\electron\dist-app\*.exe" 2>nul
if %ERRORLEVEL% neq 0 (
    echo No .exe files found -- check the electron-builder output above.
)

endlocal
