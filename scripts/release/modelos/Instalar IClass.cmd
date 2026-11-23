@echo off
rem Instalar IClass: instala o IClass neste computador (ou atualiza o que ja esta
rem instalado) a partir desta pasta do pacote (fase 3, A17 / P6-S5).
rem
rem Este arquivo so chama o instalar.ps1 do lado dele, que faz o que e do Windows
rem (pasta, atalhos, firewall, ligar com o Windows, Adicionar ou remover programas)
rem e chama o launcher do IClass (node\node.exe backend\scripts\launcher.js instalar)
rem para copiar o programa e trazer os dados.
rem Sem blocos entre parenteses: um caminho com ")" quebraria o if.
setlocal
set "ICLASS_PACOTE=%~dp0"
if not exist "%ICLASS_PACOTE%instalar.ps1" goto sem_script
if not exist "%ICLASS_PACOTE%node\node.exe" goto sem_node
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ICLASS_PACOTE%instalar.ps1" %*
set "ICLASS_SAIDA=%ERRORLEVEL%"
if "%ICLASS_SAIDA%"=="0" exit /b 0
echo.
echo A instalacao nao terminou (codigo %ICLASS_SAIDA%). Veja a mensagem acima.
echo Se o Windows nao deixou o PowerShell rodar (politica da escola), instale assim:
echo   1. abra o Prompt de Comando nesta pasta;
echo   2. rode: node\node.exe backend\scripts\launcher.js instalar
echo   3. depois abra o IClass pelo arquivo IClass.cmd da pasta da instalacao (C:\IClass).
echo.
pause
exit /b %ICLASS_SAIDA%

:sem_script
echo.
echo Falta o arquivo instalar.ps1 nesta pasta:
echo   %ICLASS_PACOTE%
echo Extraia o ZIP do IClass inteiro (botao direito, Extrair tudo) e rode de novo.
echo.
pause
exit /b 2

:sem_node
echo.
echo Falta o arquivo node\node.exe nesta pasta:
echo   %ICLASS_PACOTE%
echo O antivirus pode ter removido o arquivo. Extraia o ZIP do IClass de novo.
echo.
pause
exit /b 2
