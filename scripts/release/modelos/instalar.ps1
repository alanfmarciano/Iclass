# Instalador do IClass para Windows (fase 3, A17 / P6-S5; D12 do P6).
#
# Aberto pelo "Instalar IClass.cmd" da pasta do pacote (o ZIP extraído). Faz só o que é do
# Windows: desbloquear os arquivos baixados, escolher a pasta, liberar o IClass no firewall
# (um pedido de permissão do Windows), atalhos na Área de Trabalho e no Menu Iniciar, ligar
# junto com o Windows e "Adicionar ou remover programas". A cópia do programa, a
# atualização, os dados trazidos da pasta antiga e a conferência ficam no launcher do
# IClass (node\node.exe backend\scripts\launcher.js instalar), que tem teste automático.
# Nada em dados\, conteudo\ ou cursos-arquivados\ é apagado ou movido.
#
# Este arquivo é UTF-8 com BOM (o PowerShell 5.1 lê sem BOM como ANSI e estraga os acentos).
param(
    [string]$Pasta = '',
    [string]$TrazerDe = '',
    [int]$Porta = 3000
)

$ErrorActionPreference = 'Stop'
$pacote = $PSScriptRoot
$node = Join-Path $pacote 'node\node.exe'
$launcher = Join-Path $pacote 'backend\scripts\launcher.js'
$chaveDesinstalar = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\IClass'

function Perguntar([string]$texto, [string]$padrao) {
    $resposta = Read-Host $texto
    if ([string]::IsNullOrWhiteSpace($resposta)) { return $padrao }
    return $resposta.Trim().Trim('"')
}

function SimOuNao([string]$texto, [bool]$padraoSim) {
    $sufixo = if ($padraoSim) { '(S/n)' } else { '(s/N)' }
    $resposta = Read-Host "$texto $sufixo"
    if ([string]::IsNullOrWhiteSpace($resposta)) { return $padraoSim }
    return @('s', 'sim', 'y', 'yes') -contains $resposta.Trim().ToLower()
}

function Sair([int]$codigo, [string]$texto) {
    if ($texto) { Write-Host ''; Write-Host $texto }
    exit $codigo
}

function LerJson([string]$arquivo) {
    if (-not (Test-Path -LiteralPath $arquivo)) { return $null }
    try { return (Get-Content -LiteralPath $arquivo -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { return $null }
}

function CriarAtalho([string]$arquivo, [string]$alvo, [string]$argumentos, [string]$pasta, [string]$descricao, [int]$janela) {
    $shell = New-Object -ComObject WScript.Shell
    $atalho = $shell.CreateShortcut($arquivo)
    $atalho.TargetPath = $alvo
    $atalho.Arguments = $argumentos
    $atalho.WorkingDirectory = $pasta
    $atalho.Description = $descricao
    $atalho.WindowStyle = $janela
    $atalho.Save()
}

Write-Host ''
Write-Host '=========================================='
Write-Host '  Instalação do IClass'
Write-Host '=========================================='

if (-not (Test-Path -LiteralPath $node) -or -not (Test-Path -LiteralPath $launcher)) {
    Sair 2 "Faltam arquivos do IClass em $pacote. Extraia o ZIP inteiro (botão direito, Extrair tudo) e rode de novo."
}

# 1. Os arquivos que vieram da internet têm a "marca da web": sem tirar, o Windows pergunta
#    (ou bloqueia) cada vez que o IClass abre.
Get-ChildItem -LiteralPath $pacote -Recurse -File -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue

$manifesto = LerJson (Join-Path $pacote 'release-manifest.json')
if (-not $manifesto -or -not $manifesto.versao) { Sair 2 'O release-manifest.json do pacote está ilegível. Baixe o pacote do IClass de novo.' }
$versao = [string]$manifesto.versao
Write-Host "Versão do pacote: $versao"

# 2. Onde instalar: a instalação que já existe (pelo registro de Adicionar ou remover
#    programas) é atualizada; senão, C:\IClass ou a pasta escolhida.
$existente = $null
if (Test-Path $chaveDesinstalar) {
    $local = (Get-ItemProperty -Path $chaveDesinstalar -ErrorAction SilentlyContinue).InstallLocation
    if ($local -and (Test-Path -LiteralPath (Join-Path $local 'iclass-instalacao.json'))) { $existente = $local }
}
$padrao = Join-Path $env:SystemDrive 'IClass'
if (-not $existente -and (Test-Path -LiteralPath (Join-Path $padrao 'iclass-instalacao.json'))) { $existente = $padrao }

if ($Pasta) {
    $raiz = $Pasta
} elseif ($existente) {
    $info = LerJson (Join-Path $existente 'iclass-instalacao.json')
    $atual = if ($info -and $info.versaoAtual) { [string]$info.versaoAtual } else { '?' }
    Write-Host "Encontrei o IClass $atual instalado em $existente."
    if (-not (SimOuNao "Atualizar para a versão $versao?" $true)) { Sair 1 'Nada foi feito.' }
    $raiz = $existente
} else {
    $raiz = Perguntar "Onde instalar? [$padrao]" $padrao
}
$raiz = [System.IO.Path]::GetFullPath($raiz)
$atualizacao = Test-Path -LiteralPath (Join-Path $raiz 'iclass-instalacao.json')
$comDados = Test-Path -LiteralPath (Join-Path $raiz 'dados\database.db')

# 3. Instalação nova: a pasta antiga do IClass (a do ligarIclassV3.bat, pelo git) pode
#    trazer os dados. A pasta antiga fica como está.
if (-not $atualizacao -and -not $comDados -and -not $TrazerDe) {
    $candidatas = @()
    foreach ($base in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('MyDocuments'), (Join-Path $env:USERPROFILE 'Downloads'), $env:USERPROFILE, "$env:SystemDrive\")) {
        if (-not $base -or -not (Test-Path -LiteralPath $base)) { continue }
        if (Test-Path -LiteralPath (Join-Path $base 'ligarIclassV3.bat')) { $candidatas += $base }
        Get-ChildItem -LiteralPath $base -Directory -ErrorAction SilentlyContinue | ForEach-Object {
            if (Test-Path -LiteralPath (Join-Path $_.FullName 'ligarIclassV3.bat')) { $candidatas += $_.FullName }
        }
    }
    $antiga = $candidatas | Where-Object { Test-Path -LiteralPath (Join-Path $_ 'data\database.db') } | Select-Object -First 1
    if ($antiga) {
        if (SimOuNao "Encontrei uma instalação antiga em $antiga. Trazer os dados dela?" $true) { $TrazerDe = $antiga }
    } else {
        $digitada = Perguntar 'Se você já usava o IClass em outra pasta (a do ligarIclassV3.bat), digite o caminho dela para trazer os dados (Enter: começar do zero)' ''
        if ($digitada) { $TrazerDe = $digitada }
    }
}

# 4. Firewall: as regras valem para o node.exe desta versão (TCP da porta e UDP 5353 do
#    nome iclass.local), só nas redes privada e de domínio. Antes de copiar, para o Windows
#    não perguntar de novo quando o IClass abrir. Um pedido de permissão (UAC) só.
$nodeInstalado = Join-Path $raiz "programa\$versao\node\node.exe"
$firewall = 'recusado'
Write-Host ''
Write-Host 'O Windows vai pedir permissão para liberar o IClass no firewall.'
$q = { param($t) $t.Replace("'", "''") }
$nomeTcp = "IClass $versao (TCP $Porta)"
$nomeUdp = "IClass $versao (mDNS UDP 5353)"
$comando = @"
`$ErrorActionPreference = 'Stop'
foreach (`$n in @('$(& $q $nomeTcp)', '$(& $q $nomeUdp)')) { Get-NetFirewallRule -DisplayName `$n -ErrorAction SilentlyContinue | Remove-NetFirewallRule }
New-NetFirewallRule -DisplayName '$(& $q $nomeTcp)' -Direction Inbound -Action Allow -Program '$(& $q $nodeInstalado)' -Protocol TCP -LocalPort $Porta -Profile Private,Domain | Out-Null
New-NetFirewallRule -DisplayName '$(& $q $nomeUdp)' -Direction Inbound -Action Allow -Program '$(& $q $nodeInstalado)' -Protocol UDP -LocalPort 5353 -Profile Private,Domain | Out-Null
"@
try {
    $codificado = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($comando))
    $processo = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $codificado)
    if ($processo.ExitCode -eq 0) { $firewall = 'liberado'; Write-Host 'Firewall liberado para o IClass.' }
    else { Write-Host "O firewall não foi liberado (código $($processo.ExitCode))." }
} catch {
    Write-Host 'O firewall não foi liberado (a permissão não foi dada).'
}
if ($firewall -ne 'liberado') {
    Write-Host "Sem isso, os celulares dos alunos não chegam ao IClass. Para liberar depois, rode este instalador de novo ou peça ao técnico: Firewall do Windows, regra de entrada para $nodeInstalado, TCP $Porta, rede privada."
}

# 5. A cópia, a atualização e os dados da pasta antiga: o launcher do IClass. Ele desliga o
#    IClass instalado antes (com prova em andamento, recusa) e liga de novo se estava ligado.
$parametros = @($launcher, 'instalar', '--destino', $raiz, '--sem-iniciar', '--firewall', $firewall, '--porta', "$Porta")
if ($TrazerDe) { $parametros += @('--trazer-de', $TrazerDe) }
& $node @parametros
if ($LASTEXITCODE -ne 0) { Sair $LASTEXITCODE 'A instalação não terminou. Veja a mensagem acima: nada nos dados foi apagado.' }

$lancador = Join-Path $raiz 'IClass.cmd'

# 6. Atalhos: Área de Trabalho e Menu Iniciar (IClass e Desinstalar o IClass).
try {
    CriarAtalho (Join-Path ([Environment]::GetFolderPath('Desktop')) 'IClass.lnk') $lancador '' $raiz 'Abre o menu do IClass' 1
    $menu = Join-Path ([Environment]::GetFolderPath('Programs')) 'IClass'
    New-Item -ItemType Directory -Path $menu -Force | Out-Null
    CriarAtalho (Join-Path $menu 'IClass.lnk') $lancador '' $raiz 'Abre o menu do IClass' 1
    CriarAtalho (Join-Path $menu 'Desinstalar o IClass.lnk') 'powershell.exe' "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $raiz 'desinstalar.ps1')`"" $raiz 'Desinstala o IClass (os dados ficam)' 1
    Write-Host 'Atalhos criados na Área de Trabalho e no Menu Iniciar.'
} catch {
    Write-Host "Não foi possível criar os atalhos ($($_.Exception.Message)). Abra o IClass pelo arquivo $lancador."
}

# 7. Ligar junto com o Windows (atalho na pasta Inicializar, pelo launcher). Na
#    atualização fica como estava.
if (-not $atualizacao) {
    $ligar = SimOuNao 'Ligar o IClass junto com o Windows?' $true
    & $lancador 'ligar-com-windows' $(if ($ligar) { 'liga' } else { 'desliga' })
}

# 8. Adicionar ou remover programas (só deste usuário, sem pedir permissão).
try {
    New-Item -Path $chaveDesinstalar -Force | Out-Null
    Set-ItemProperty -Path $chaveDesinstalar -Name 'DisplayName' -Value 'IClass'
    Set-ItemProperty -Path $chaveDesinstalar -Name 'DisplayVersion' -Value $versao
    Set-ItemProperty -Path $chaveDesinstalar -Name 'Publisher' -Value 'IClass'
    Set-ItemProperty -Path $chaveDesinstalar -Name 'InstallLocation' -Value $raiz
    Set-ItemProperty -Path $chaveDesinstalar -Name 'UninstallString' -Value "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $raiz 'desinstalar.ps1')`""
    Set-ItemProperty -Path $chaveDesinstalar -Name 'NoModify' -Value 1 -Type DWord
    Set-ItemProperty -Path $chaveDesinstalar -Name 'NoRepair' -Value 1 -Type DWord
} catch {
    Write-Host "Não foi possível registrar o IClass em Adicionar ou remover programas ($($_.Exception.Message))."
}

# 9. Rede marcada como Pública: os alunos não chegam (o firewall só abre nas privadas).
try {
    $publicas = Get-NetConnectionProfile -ErrorAction SilentlyContinue | Where-Object { $_.NetworkCategory -eq 'Public' }
    foreach ($rede in $publicas) {
        Write-Host ''
        Write-Host "Atenção: a rede '$($rede.Name)' está marcada como Pública. Os alunos não conseguem entrar no IClass por ela. Em Configurações > Rede e Internet, abra a rede e marque 'Rede privada'."
    }
} catch { }

Write-Host ''
Write-Host 'Pronto. Abrindo o IClass...'
& $lancador 'iniciar'
# A janela fica aberta para o endereço dos alunos (ou o motivo de não ter ligado) ser lido.
Write-Host ''
[void](Read-Host 'Pressione Enter para fechar esta janela')
exit 0
