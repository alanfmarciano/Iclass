@echo off
rem IClass: abre o menu do IClass (ligar, desligar, backup, restaurar, senha...).
rem Tambem aceita um comando direto: IClass.cmd iniciar, parar, reiniciar, status...
rem (lista completa: IClass.cmd --ajuda).
rem
rem Este arquivo so acha o Node do IClass e chama backend\scripts\launcher.js, que faz
rem todo o resto (fase 3, A16 / P6-S4). Ele funciona em dois lugares:
rem  - na pasta do pacote (node\node.exe e backend\ ao lado deste arquivo);
rem  - na pasta da instalacao (C:\IClass): programa\versao-atual.txt diz qual pasta de
rem    programa\<versao> vale agora.
rem Sem blocos entre parenteses: um caminho com ")" (C:\Program Files (x86)) quebraria o if.
setlocal
set "ICLASS_RAIZ=%~dp0"
set "ICLASS_PROGRAMA="
if exist "%ICLASS_RAIZ%backend\scripts\launcher.js" set "ICLASS_PROGRAMA=%ICLASS_RAIZ%"
if defined ICLASS_PROGRAMA goto achar_node
if not exist "%ICLASS_RAIZ%programa\versao-atual.txt" goto sem_programa
set "ICLASS_VERSAO="
set /p ICLASS_VERSAO=<"%ICLASS_RAIZ%programa\versao-atual.txt"
if not defined ICLASS_VERSAO goto sem_programa
set "ICLASS_PROGRAMA=%ICLASS_RAIZ%programa\%ICLASS_VERSAO%\"
if not exist "%ICLASS_PROGRAMA%backend\scripts\launcher.js" goto sem_programa

:achar_node
set "ICLASS_NODE=%ICLASS_PROGRAMA%node\node.exe"
if not exist "%ICLASS_NODE%" goto sem_node
"%ICLASS_NODE%" "%ICLASS_PROGRAMA%backend\scripts\launcher.js" %*
set "ICLASS_SAIDA=%ERRORLEVEL%"
rem Aberto com dois cliques (sem comando) e com erro: a janela espera para a mensagem ser lida.
if "%~1"=="" if not "%ICLASS_SAIDA%"=="0" pause
exit /b %ICLASS_SAIDA%

:sem_programa
echo.
echo Nao encontrei o programa do IClass nesta pasta:
echo   %ICLASS_RAIZ%
echo Abra o IClass pelo atalho da Area de Trabalho, ou reinstale o IClass.
echo.
pause
exit /b 2

:sem_node
echo.
echo Falta o arquivo node\node.exe do IClass em:
echo   %ICLASS_PROGRAMA%
echo O antivirus pode ter removido o arquivo. Reinstale esta versao do IClass.
echo.
pause
exit /b 2
