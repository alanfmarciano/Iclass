@echo off
setlocal EnableDelayedExpansion
:: Habilitar suporte a cores no Windows 10/11
for /f %%a in ('echo prompt $E ^| cmd') do set "ESC=%%a"

title Ligar IClass V3

set "VERMELHO=%ESC%[91m"
set "VERDE=%ESC%[92m"
set "AMARELO=%ESC%[93m"
set "AZUL=%ESC%[94m"
set "CIANO=%ESC%[96m"
set "BRANCO=%ESC%[97m"
set "RESET=%ESC%[0m"
set "NEGRITO=%ESC%[1m"

:: Garante que os comandos rodem a partir da pasta do .bat
cd /d "%~dp0"

:menu
cls
echo !CIANO!!NEGRITO!
echo   ICLASS V3
echo !RESET!
echo !AZUL!======================================================!RESET!
echo !BRANCO!!NEGRITO!        MENU DE GERENCIAMENTO - ICLASS V3!RESET!
echo !AZUL!======================================================!RESET!
echo.
echo   !VERDE![1]!RESET! - Iniciar Servidor !BRANCO!(abre o portal no navegador)!RESET!
echo   !VERMELHO![2]!RESET! - Parar Servidor
echo   !AMARELO![3]!RESET! - Reiniciar App
echo   !CIANO![4]!RESET! - Instalar Dependencias e Compilar Interface
echo   !AMARELO![5]!RESET! - Instalar, Compilar e abrir Modo Administrativo !BRANCO!(dados reais + acesso rapido)!RESET!
echo   !CIANO![6]!RESET! - Modo Demonstracao !BRANCO!(para apresentar ao cliente - nada e salvo)!RESET!
echo   !VERDE![7]!RESET! - Fazer Backup !BRANCO!(zip do projeto em backups\)!RESET!
echo   !CIANO![8]!RESET! - Central de Testes e Qualidade !BRANCO!(dados temporarios)!RESET!
echo   !AMARELO![S]!RESET! - Redefinir Senha do Administrador !BRANCO!(gera senha temporaria)!RESET!
echo   !BRANCO![9]!RESET! - Sair
echo.
echo !AZUL!======================================================!RESET!
set /p opcao="!AMARELO!Escolha uma opcao (1-9 ou S): !RESET!"

if "%opcao%"=="1" goto iniciar
if "%opcao%"=="2" goto parar
if "%opcao%"=="3" goto reiniciar
if "%opcao%"=="4" goto instalar
if "%opcao%"=="5" goto configurar
if "%opcao%"=="6" goto testar
if "%opcao%"=="7" goto backup
if "%opcao%"=="8" goto central_testes
if "%opcao%"=="9" goto sair
if /I "%opcao%"=="S" goto senha_admin

goto menu

:iniciar
cls
echo !BRANCO!!NEGRITO! INICIANDO O SERVIDOR...!RESET!
echo.
node -v >nul 2>&1
if !errorlevel! neq 0 (
    echo !VERMELHO![ERRO] Node.js nao encontrado. Instale em https://nodejs.org!RESET!
    pause
    goto menu
)
if not exist "web\dist\index.html" (
    echo !AMARELO![AVISO] A interface ainda nao foi compilada. Rode a opcao [4].!RESET!
    pause
    goto menu
)
echo !VERDE![OK]!RESET! Iniciando servidor na porta 3000...
start "Servidor IClass V3" cmd /c "node backend/server.js"
timeout /t 3 /nobreak >nul
call :abrirNavegador
echo.
echo !VERDE!!NEGRITO!Servidor iniciado em uma nova janela.!RESET!
pause
goto menu

:configurar
cls
echo !CIANO!!NEGRITO! INSTALANDO DEPENDENCIAS E COMPILANDO...!RESET!
echo.
call "%~dp0INSTALAR_E_COMPILAR.bat" --no-pause
if errorlevel 1 goto menu

cls
echo !AMARELO!!NEGRITO! CONFIGURACAO INICIAL / MODO ADMINISTRATIVO...!RESET!
echo.
node -v >nul 2>&1
if !errorlevel! neq 0 (
    echo !VERMELHO![ERRO] Node.js nao encontrado. Instale em https://nodejs.org!RESET!
    pause
    goto menu
)
if not exist "web\dist\index.html" (
    echo !AMARELO![AVISO] A interface ainda nao foi compilada. Rode a opcao [4].!RESET!
    pause
    goto menu
)
echo !CIANO!Este modo usa o banco REAL e mostra acessos rapidos apenas neste computador.!RESET!
echo !CIANO!Os botoes usam as contas oficiais de teste ja cadastradas!RESET!
echo !CIANO!nem alterar senhas.!RESET!
echo !AMARELO!Para o cliente final em producao, use a opcao [1] (sem os botoes).!RESET!
for /f "tokens=5" %%a in ('netstat -aon ^| findstr /r /c:":3000 "') do (
    taskkill /f /pid %%a >nul 2>&1
)
for /f %%T in ('powershell -NoProfile -Command "[guid]::NewGuid().ToString([char]78)"') do set "SETUP_TOKEN=%%T"
if "!SETUP_TOKEN!"=="" (
    echo !VERMELHO![ERRO] Nao foi possivel gerar a autorizacao local.!RESET!
    pause
    goto menu
)
start "Servidor IClass V3 (ADMIN)" cmd /c "set TEST_MODE=&& set ICLASS_ADMIN_SETUP_MODE=1&& set ICLASS_ADMIN_SETUP_TOKEN=!SETUP_TOKEN!&& set ICLASS_DATA_DIR=&& set ICLASS_CONTENT_DIR=&& set ICLASS_ARCHIVE_DIR=&& set PORT=3000&& node backend/server.js"
timeout /t 3 /nobreak >nul
echo.
if exist "data\bootstrap-admin.txt" (
    echo !AMARELO!Se esta for a primeira inicializacao, a credencial temporaria esta em:!RESET!
    echo !BRANCO!%~dp0data\bootstrap-admin.txt!RESET!
    echo !AMARELO!Entre como Instrutor e troque a senha imediatamente.!RESET!
) else (
    echo !VERDE![OK]!RESET! Use uma conta administrativa ja cadastrada.
)
set "TARGET_URL=http://127.0.0.1:3000/login?mode=admin#local-quick=!SETUP_TOKEN!"
set "SECONDARY_URL=http://localhost:3000/login#local-quick=!SETUP_TOKEN!"
set "SETUP_TOKEN="
set "OPEN_ISOLATED_WINDOWS=1"
echo !CIANO!Abrindo duas janelas normais e isoladas: professor e aluno.!RESET!
call :abrirNavegador
echo.
echo !VERDE!!NEGRITO!Modo local com acesso rapido iniciado com os dados reais.!RESET!
pause
goto menu

:testar
cls
echo !CIANO!!NEGRITO! MODO DEMONSTRACAO (APRESENTACAO AO CLIENTE)...!RESET!
echo.
node -v >nul 2>&1
if !errorlevel! neq 0 (
    echo !VERMELHO![ERRO] Node.js nao encontrado. Instale em https://nodejs.org!RESET!
    pause
    goto menu
)
if not exist "web\dist\index.html" (
    echo !AMARELO![AVISO] A interface ainda nao foi compilada. Rode a opcao [4].!RESET!
    pause
    goto menu
)
echo !CIANO!Ambiente 100%% ficticio e ISOLADO: nada dos dados reais e lido ou alterado.!RESET!
echo !CIANO!O cliente pode testar o app inteiro; a cada nova demonstracao o ambiente!RESET!
echo !CIANO!e RECRIADO DO ZERO (nada que ele fizer fica salvo).!RESET!
echo !CIANO!Na tela de login, use os botoes Administrador / Professor / Aluno.!RESET!
echo.
for /f "tokens=5" %%a in ('netstat -aon ^| findstr /r /c:":3000 "') do (
    taskkill /f /pid %%a >nul 2>&1
)
echo !AMARELO!Preparando ambiente de demonstracao limpo...!RESET!
if exist "data-demo" rmdir /s /q "data-demo" >nul 2>&1
if exist "content-demo" rmdir /s /q "content-demo" >nul 2>&1
if exist "cursos_arquivados-demo" rmdir /s /q "cursos_arquivados-demo" >nul 2>&1
mkdir "data-demo" >nul 2>&1
mkdir "content-demo" >nul 2>&1
mkdir "cursos_arquivados-demo" >nul 2>&1
start "Servidor IClass V3 (DEMONSTRACAO)" cmd /c "set TEST_MODE=1&& set ICLASS_ADMIN_SETUP_MODE=&& set ICLASS_ADMIN_SETUP_TOKEN=&& set ICLASS_DATA_DIR=%~dp0data-demo&& set ICLASS_CONTENT_DIR=%~dp0content-demo&& set ICLASS_ARCHIVE_DIR=%~dp0cursos_arquivados-demo&& set PORT=3000&& node backend/server.js"
timeout /t 4 /nobreak >nul
echo !AMARELO!Populando dados de demonstracao (curso, turma, alunos e notas)...!RESET!
powershell -NoProfile -Command "try { Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3000/api/test/seed' -TimeoutSec 15 | Out-Null; exit 0 } catch { exit 1 }" >nul 2>&1
if !errorlevel! neq 0 (
    echo !AMARELO![AVISO] Nao foi possivel popular automaticamente. Os botoes de acesso!RESET!
    echo !AMARELO!rapido na tela de login criam os dados ao serem clicados.!RESET!
) else (
    echo !VERDE![OK] Dados de demonstracao prontos.!RESET!
)
set "TARGET_URL=http://127.0.0.1:3000/login"
call :abrirNavegador
echo.
echo !VERDE!!NEGRITO!Modo demonstracao iniciado. Nada sera salvo nos dados reais.!RESET!
echo !CIANO!Ao final da apresentacao, pare o servidor [2]. Na proxima demonstracao!RESET!
echo !CIANO!o ambiente volta limpo automaticamente.!RESET!
pause
goto menu

:parar
cls
echo !VERMELHO!!NEGRITO! PARANDO O SERVIDOR...!RESET!
echo.
set "porta_em_uso=false"
for /f "tokens=5" %%a in ('netstat -aon ^| findstr /r /c:":3000 "') do (
    set "porta_em_uso=true"
    taskkill /f /pid %%a >nul 2>&1
)
if "!porta_em_uso!"=="false" (
    echo !CIANO![AVISO] Nenhum servidor rodando na porta 3000.!RESET!
) else (
    echo !VERDE![OK] Servidor encerrado.!RESET!
)
echo.
pause
goto menu

:reiniciar
cls
echo !AMARELO!!NEGRITO! REINICIANDO O APP...!RESET!
echo.
for /f "tokens=5" %%a in ('netstat -aon ^| findstr /r /c:":3000 "') do (
    taskkill /f /pid %%a >nul 2>&1
)
if not exist "web\dist\index.html" (
    echo !AMARELO![AVISO] Interface nao compilada. Rode a opcao [4] primeiro.!RESET!
    pause
    goto menu
)
start "Servidor IClass V3" cmd /c "node backend/server.js"
timeout /t 3 /nobreak >nul
call :abrirNavegador
echo.
echo !VERDE!!NEGRITO!Aplicativo reiniciado!!RESET!
pause
goto menu

:instalar
cls
echo !CIANO!!NEGRITO! INSTALANDO DEPENDENCIAS E COMPILANDO...!RESET!
echo.
call "%~dp0INSTALAR_E_COMPILAR.bat"
goto menu

:abrirNavegador
if "!TARGET_URL!"=="" set "TARGET_URL=http://localhost:3000/"
set "BROWSER_PATH="
set "BROWSER_KIND="
for %%P in (
    "HKLM\Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe"
    "HKCU\Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe"
) do (
    for /f "tokens=2*" %%A in ('reg query %%P /ve 2^>nul') do (
        set "BROWSER_PATH=%%B"
        set "BROWSER_KIND=chrome"
    )
)
if "!BROWSER_PATH!"=="" (
    for %%P in (
        "HKLM\Software\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe"
        "HKCU\Software\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe"
    ) do (
        for /f "tokens=2*" %%A in ('reg query %%P /ve 2^>nul') do (
            set "BROWSER_PATH=%%B"
            set "BROWSER_KIND=edge"
        )
    )
)
if "!BROWSER_PATH!"=="" (
    for %%P in (
        "HKLM\Software\Microsoft\Windows\CurrentVersion\App Paths\firefox.exe"
        "HKCU\Software\Microsoft\Windows\CurrentVersion\App Paths\firefox.exe"
    ) do (
        for /f "tokens=2*" %%A in ('reg query %%P /ve 2^>nul') do (
            set "BROWSER_PATH=%%B"
            set "BROWSER_KIND=firefox"
        )
    )
)
if not "!BROWSER_PATH!"=="" (
    if /I "!BROWSER_KIND!"=="firefox" (
        start "" "!BROWSER_PATH!" -new-window "!TARGET_URL!"
    ) else (
        start "" "!BROWSER_PATH!" --new-window "!TARGET_URL!"
    )
    if "!OPEN_ISOLATED_WINDOWS!"=="1" (
        timeout /t 1 /nobreak >nul
        if /I "!BROWSER_KIND!"=="firefox" (
            start "" "!BROWSER_PATH!" -new-window "!SECONDARY_URL!"
        ) else (
            start "" "!BROWSER_PATH!" --new-window "!SECONDARY_URL!"
        )
    )
) else (
    start "" "!TARGET_URL!"
    if "!OPEN_ISOLATED_WINDOWS!"=="1" start "" "!SECONDARY_URL!"
)
set "TARGET_URL="
set "SECONDARY_URL="
set "OPEN_ISOLATED_WINDOWS="
set "BROWSER_KIND="
exit /b

:backup
cls
echo !CIANO!!NEGRITO! FAZENDO BACKUP (ZIP)...!RESET!
echo.
echo !AMARELO!Parando o servidor para um backup consistente...!RESET!
for /f "tokens=5" %%a in ('netstat -aon ^| findstr /r /c:":3000 "') do taskkill /f /pid %%a >nul 2>&1
timeout /t 2 /nobreak >nul
echo.
:: Destino configuravel: edite o arquivo backup_path.txt (1a linha = a pasta de destino).
set "CFG=%~dp0backup_path.txt"
if not exist "%CFG%" (>"%CFG%" echo %~dp0backups)
set "DESTINO=%~dp0backups"
set /p DESTINO=<"%CFG%"
echo Salvando em: %DESTINO%
if not exist "%DESTINO%" mkdir "%DESTINO%"
for /f %%I in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd_HH-mm-ss"') do set "STAMP=%%I"
set "ZIP=%DESTINO%\IclassV3_backup_!STAMP!.zip"
set "STAGE=%TEMP%\iclass_bkp_%RANDOM%"
echo Copiando arquivos da pasta (exceto node_modules)...
robocopy "%~dp0." "!STAGE!\IclassV3" /E /XD node_modules >nul
echo Compactando em ZIP...
powershell -NoProfile -Command "Compress-Archive -Path '!STAGE!\IclassV3' -DestinationPath '!ZIP!' -Force"
rmdir /s /q "!STAGE!" >nul 2>&1
if exist "!ZIP!" (
    echo !VERDE![OK] Backup criado em:!RESET! !ZIP!
    echo !CIANO!Servidor parado. Use a opcao [1] para religar quando quiser.!RESET!
) else (
    echo !VERMELHO![ERRO] Falha ao criar o backup. Verifique espaco/permissoes.!RESET!
)
echo.
pause
goto menu

:central_testes
cls
if not exist "%~dp0VALIDAR_ICLASS.bat" (
    echo !VERMELHO![ERRO] O arquivo VALIDAR_ICLASS.bat nao foi encontrado.!RESET!
    pause
    goto menu
)
call "%~dp0VALIDAR_ICLASS.bat"
goto menu

:senha_admin
cls
echo !AMARELO!!NEGRITO! REDEFINIR SENHA DO ADMINISTRADOR...!RESET!
echo.
echo !CIANO!Gera uma senha temporaria para uma conta administrativa, sem precisar da senha atual.!RESET!
echo !CIANO!A conta sera obrigada a trocar a senha no proximo login. O servidor e parado antes.!RESET!
echo.
set "ADMIN_EMAIL="
set /p ADMIN_EMAIL="E-mail da conta (vazio = primeiro administrador): "
for /f "tokens=5" %%a in ('netstat -aon ^| findstr /r /c:":3000 "') do taskkill /f /pid %%a >nul 2>&1
timeout /t 1 /nobreak >nul
node backendscriptseset-admin-password.js "!ADMIN_EMAIL!"
set "ADMIN_EMAIL="
echo.
echo !CIANO!Servidor parado. Use a opcao [1] para religar e entrar com a senha temporaria.!RESET!
pause
goto menu

:sair
exit
