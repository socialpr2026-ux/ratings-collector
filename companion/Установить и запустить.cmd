@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 (
  echo Для локального сбора нужен Node.js 20.
  echo Установите Node.js 20 LTS с https://nodejs.org/ и запустите этот файл снова.
  pause
  exit /b 1
)

for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set NODE_MAJOR=%%v
if %NODE_MAJOR% LSS 20 (
  echo Нужен Node.js версии 20 или новее. Сейчас установлен Node.js %NODE_MAJOR%.
  pause
  exit /b 1
)

call corepack pnpm install --frozen-lockfile
if errorlevel 1 (
  echo Не удалось установить компоненты локального сборщика.
  pause
  exit /b 1
)

echo.
echo Окно можно свернуть. Не закрывайте его во время сбора Ozon.
echo При первом запуске Chrome может попросить подтвердить, что вы человек.
echo.
call corepack pnpm exec tsx companion/start.ts
pause
