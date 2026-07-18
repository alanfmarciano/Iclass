@echo off
title IClass V3 - Instalar e Compilar
cd /d "%~dp0"

echo ==================================================
echo   ICLASS V3 - INSTALAR DEPENDENCIAS E COMPILAR
echo ==================================================
echo.
echo Esta etapa precisa de INTERNET na primeira vez.
echo Depois de compilada, a plataforma roda offline.
echo.

echo Verificando Node.js...
where node >nul 2>&1
if errorlevel 1 (
  echo [ERRO] Node.js nao encontrado no PATH.
  echo Instale em https://nodejs.org e feche/abra o terminal.
  echo.
  pause
  exit /b 1
)
call node -v
call npm -v
echo.

echo [1/3] Instalando dependencias do backend...
call npm install
if errorlevel 1 goto erro
echo.

echo [2/3] Instalando dependencias da interface (web)...
call npm --prefix web install
if errorlevel 1 goto erro
echo.

echo [3/3] Compilando a interface React...
call npm --prefix web run build
if errorlevel 1 goto erro
echo.

if exist "web\dist\index.html" (
  echo [OK] Tudo pronto! Agora rode ligarIclassV3.bat e escolha a opcao [1].
) else (
  echo [ERRO] O build terminou mas web\dist\index.html nao foi criado.
)
echo.
if /i not "%~1"=="--no-pause" pause
exit /b 0

:erro
echo.
echo ==================================================
echo [ERRO] Um passo falhou. Leia a mensagem acima.
echo Causas comuns: sem internet, Node.js antigo, ou antivirus bloqueando.
echo ==================================================
echo.
pause
exit /b 1
