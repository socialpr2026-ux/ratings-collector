@echo off
setlocal EnableExtensions
title Ratings Collector - Ozon helper

powershell -NoProfile -Command "try { $h=Invoke-RestMethod -TimeoutSec 2 http://127.0.0.1:8765/health; if($h.ok -and $h.capabilities -contains 'ozon'){exit 0} }; exit 1" >nul 2>nul
if not errorlevel 1 (
  echo Ozon helper is already running.
  echo Return to the web interface and click the collection button.
  pause
  exit /b 0
)

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 is required.
  echo Install Node.js 20 LTS from https://nodejs.org/ and run this file again.
  pause
  exit /b 1
)

for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set "NODE_MAJOR=%%v"
if not "%NODE_MAJOR%"=="20" (
  echo Node.js 20 LTS is required. Installed major version: %NODE_MAJOR%.
  pause
  exit /b 1
)

set "APP=%LOCALAPPDATA%\RatingsCollector\app"
set "STAGE=%TEMP%\RatingsCollectorInstall-%RANDOM%-%RANDOM%"
set "ARCHIVE=%STAGE%\ratings-collector.zip"
set "DOWNLOAD_URL=https://codeload.github.com/socialpr2026-ux/ratings-collector/zip/9ae4a05a6a87e15c5069ea0d0ae7012ff79edbfa"

echo Downloading the current Ozon helper...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; $null=New-Item -ItemType Directory -Force -Path '%STAGE%'; Invoke-WebRequest -UseBasicParsing -Uri '%DOWNLOAD_URL%' -OutFile '%ARCHIVE%'; Expand-Archive -LiteralPath '%ARCHIVE%' -DestinationPath '%STAGE%' -Force"
if errorlevel 1 (
  echo The helper download failed. Check the internet connection and retry.
  pause
  exit /b 1
)

set "SOURCE="
for /d %%D in ("%STAGE%\ratings-collector-*") do if not defined SOURCE set "SOURCE=%%~fD"
if not defined SOURCE (
  echo The downloaded helper package is invalid.
  pause
  exit /b 1
)

if not exist "%APP%" mkdir "%APP%"
robocopy "%SOURCE%" "%APP%" /E /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 (
  echo The helper could not be installed in %APP%.
  pause
  exit /b 1
)

cd /d "%APP%"
call corepack pnpm install --frozen-lockfile --config.node-linker=hoisted
if errorlevel 1 (
  echo The helper dependencies could not be installed.
  pause
  exit /b 1
)

echo.
echo Ozon helper is ready. Keep this window open during collection.
echo Return to the web interface and click the collection button.
echo Chrome will open automatically after that click.
echo.
call corepack pnpm exec tsx companion/start.ts
pause
