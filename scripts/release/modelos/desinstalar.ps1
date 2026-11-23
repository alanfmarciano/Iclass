# Desinstalador do IClass para Windows (fase 3, A17 / P6-S5; D12 do P6).
#
# Aberto pelo atalho "Desinstalar o IClass" do Menu Iniciar ou por Adicionar ou remover
# programas. O launcher do IClass (launcher.js desinstalar) desliga o IClass (com prova em
# andamento, recusa), tira o atalho de ligar com o Windows e pergunta pelos dados: eles
# ficam, a não ser que a pessoa digite APAGAR. Depois este arquivo apaga a pasta do
# programa, os atalhos, as regras do firewall (um pedido de permissão do Windows) e o
# registro de Adicionar ou remover programas.
#
# Este arquivo é UTF-8 com BOM (o PowerShell 5.1 lê sem BOM como ANSI e estraga os acentos).
$ErrorActionPreference = 'Stop'
$chaveDesinstalar = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\IClass'

function Sair([int]$codigo, [string]$texto) {
    if ($texto) { Write-Host ''; Write-Host $texto }
    Write-Host ''
    Read-Host 'Pressione Enter para fechar' | Out-Null
    exit $codigo
}

# A pasta da instalação: a deste arquivo (C:\IClass\desinstalar.ps1) ou a do registro.
$raiz = $PSScriptRoot
if (-not (Test-Path -LiteralPath (Join-Path $raiz 'iclass-instalacao.json'))) {
    $raiz = $null
    if (Test-Path $chaveDesinstalar) { $raiz = (Get-ItemProperty -Path $chaveDesinstalar -ErrorAction SilentlyContinue).InstallLocation }
}
if (-not $raiz -or -not (Test-Path -LiteralPath (Join-Path $raiz 'iclass-instalacao.json'))) { Sair 1 'Não encontrei uma instalação do IClass neste computador.' }
$raiz = [System.IO.Path]::GetFullPath($raiz)

$versao = ''
try { $versao = (Get-Content -LiteralPath (Join-Path $raiz 'programa\versao-atual.txt') -TotalCount 1).Trim() } catch { }
$programa = Join-Path $raiz "programa\$versao"
$node = Join-Path $programa 'node\node.exe'
$launcher = Join-Path $programa 'backend\scripts\launcher.js'
if (-not $versao -or -not (Test-Path -LiteralPath $node) -or -not (Test-Path -LiteralPath $launcher)) { Sair 1 "O programa do IClass em $raiz está incompleto. Apague a pasta $(Join-Path $raiz 'programa') à mão; os dados ficam em $raiz." }

Write-Host ''
Write-Host '=========================================='
Write-Host '  Desinstalar o IClass'
Write-Host '=========================================='

# A pasta atual não pode ser a do programa (o Windows não apaga uma pasta em uso).
Set-Location -LiteralPath $env:TEMP
& $node $launcher 'desinstalar'
if ($LASTEXITCODE -ne 0) { Sair $LASTEXITCODE 'Nada foi desinstalado.' }

# Atalhos da Área de Trabalho e do Menu Iniciar.
Remove-Item -LiteralPath (Join-Path ([Environment]::GetFolderPath('Desktop')) 'IClass.lnk') -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path ([Environment]::GetFolderPath('Programs')) 'IClass') -Recurse -Force -ErrorAction SilentlyContinue

# Regras do firewall de todas as versões (um pedido de permissão do Windows).
Write-Host 'O Windows vai pedir permissão para tirar as regras do IClass do firewall.'
try {
    $comando = "Get-NetFirewallRule -DisplayName 'IClass *' -ErrorAction SilentlyContinue | Remove-NetFirewallRule"
    $codificado = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($comando))
    Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $codificado) | Out-Null
} catch {
    Write-Host 'As regras do firewall ficaram (a permissão não foi dada). Elas não fazem nada sem o IClass.'
}

Remove-Item -Path $chaveDesinstalar -Recurse -Force -ErrorAction SilentlyContinue

# O programa (todas as versões) e os lançadores da raiz. Os dados ficaram onde estavam, a
# não ser que a pessoa tenha digitado APAGAR no passo do launcher.
Start-Sleep -Seconds 1
Remove-Item -LiteralPath (Join-Path $raiz 'programa') -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path $raiz 'IClass.cmd') -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path $raiz 'iclass-instalacao.json') -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path $raiz 'desinstalar.ps1') -Force -ErrorAction SilentlyContinue
if ((Test-Path -LiteralPath $raiz) -and -not (Get-ChildItem -LiteralPath $raiz -Force -ErrorAction SilentlyContinue)) { Remove-Item -LiteralPath $raiz -Force -ErrorAction SilentlyContinue }
if (Test-Path -LiteralPath (Join-Path $raiz 'programa')) { Write-Host "Não foi possível apagar tudo em $(Join-Path $raiz 'programa'): apague à mão depois de reiniciar o computador." }

Sair 0 'IClass desinstalado.'
