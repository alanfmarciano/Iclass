@echo off
setlocal EnableExtensions
title IClass V3 - Central de Testes e Qualidade
cd /d "%~dp0"

:menu
cls
echo ============================================================
echo        ICLASS V3 - CENTRAL DE TESTES E QUALIDADE
echo ============================================================
echo.
echo Todos os casos de uso no navegador utilizam dados temporarios.
echo O banco real, as apostilas e os arquivos operacionais nao sao alterados.
echo.
echo [1] Validacao rapida
echo [2] Testar provas
echo [3] Testar administradores e permissoes
echo [4] Testar alunos e matriculas
echo [5] Testar cursos e turmas
echo [6] Testar layouts Premium e Lumen
echo [7] Testar seguranca
echo [8] Testar presenca e frequencia
echo [9] Validacao completa
echo [R] Ver ultimo relatorio
echo [P] Preparar ambiente de testes
echo [0] Voltar
echo.
set /p TEST_OPTION="Escolha uma opcao: "

if /I "%TEST_OPTION%"=="1" goto quick
if /I "%TEST_OPTION%"=="2" goto provas
if /I "%TEST_OPTION%"=="3" goto admins
if /I "%TEST_OPTION%"=="4" goto alunos
if /I "%TEST_OPTION%"=="5" goto cursos
if /I "%TEST_OPTION%"=="6" goto layout
if /I "%TEST_OPTION%"=="7" goto security
if /I "%TEST_OPTION%"=="8" goto presenca
if /I "%TEST_OPTION%"=="9" goto full
if /I "%TEST_OPTION%"=="R" goto report
if /I "%TEST_OPTION%"=="P" goto setup
if /I "%TEST_OPTION%"=="0" exit /b 0
goto menu

:preflight
where node >nul 2>&1
if errorlevel 1 (
  echo [ERRO] Node.js nao foi encontrado no PATH.
  echo Instale o Node.js 20.19 ou superior e tente novamente.
  pause
  exit /b 1
)
if not exist "node_modules\@playwright\test" (
  echo [AVISO] O ambiente de testes ainda nao foi preparado.
  echo Use a opcao [P] antes dos testes completos ou de navegador.
)
exit /b 0

:execute
call :preflight
if errorlevel 1 goto menu
echo.
call npm.cmd run test:module -- %TEST_MODULE%
set "TEST_EXIT=%ERRORLEVEL%"
echo.
if "%TEST_EXIT%"=="0" (
  echo [OK] Modulo aprovado.
) else if "%TEST_EXIT%"=="2" (
  echo [BLOQUEADO] Prepare o navegador automatizado pela opcao [P].
) else (
  echo [FALHA] Consulte test-results\ultimo-relatorio.html.
)
echo.
pause
goto menu

:quick
set "TEST_MODULE=quick"
goto execute

:provas
set "TEST_MODULE=provas"
goto execute

:admins
set "TEST_MODULE=admins"
goto execute

:alunos
set "TEST_MODULE=alunos"
goto execute

:cursos
set "TEST_MODULE=cursos"
goto execute

:layout
set "TEST_MODULE=layout"
goto execute

:security
set "TEST_MODULE=security"
goto execute

:presenca
set "TEST_MODULE=presenca"
goto execute

:full
set "TEST_MODULE=full"
goto execute

:setup
call :preflight
if errorlevel 1 goto menu
echo.
echo Esta etapa pode precisar de internet para baixar o Chromium.
call npm.cmd run test:setup
echo.
pause
goto menu

:report
if exist "test-results\ultimo-relatorio.html" (
  start "" "test-results\ultimo-relatorio.html"
) else (
  echo Nenhum relatorio foi gerado ainda.
  pause
)
goto menu
