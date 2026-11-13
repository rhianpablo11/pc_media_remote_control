#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Configura a regra de entrada no Firewall do Windows para o PC Media Control.

.DESCRIPTION
    Cria ou atualiza a regra de entrada no Firewall do Windows autorizando
    conexões TCP na porta 8765 apenas da sub-rede local (RemoteAddress LocalSubnet),
    e verifica se a rede Wi-Fi/Ethernet atual está configurada como Perfil Privado.

.EXAMPLE
    PowerShell executado como Administrador:
    .\scripts\allow_firewall.ps1
#>

[CmdletBinding()]
param(
    [int]$Port = 8765,
    [string]$RuleName = "PC Media Control Host (Porta 8765)"
)

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "   PC Media Control — Configuração do Firewall do Windows  " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host ""

# 1. Verificar categoria das conexões de rede ativas
Write-Host "[1/3] Verificando perfil das redes ativas..." -ForegroundColor Yellow
$profiles = Get-NetConnectionProfile
$hasPublic = $false

foreach ($p in $profiles) {
    $categoryName = switch ($p.NetworkCategory) {
        0 { "Público (Bloqueia conexões de entrada por padrão)" }
        1 { "Privado (Recomendado para controle local)" }
        2 { "Domínio" }
        default { "Desconhecido" }
    }
    Write-Host "  -> Interface: $($p.InterfaceAlias) | Rede: $($p.Name) | Perfil: $categoryName"

    if ($p.NetworkCategory -eq 0) {
        $hasPublic = $true
        $publicAlias = $p.InterfaceAlias
    }
}

if ($hasPublic) {
    Write-Host ""
    Write-Host "  [ATENÇÃO] Uma ou mais redes ativas estão como Perfil Público!" -ForegroundColor Red
    Write-Host "  Para que o celular consiga acessar o notebook, mude a rede para Privada:" -ForegroundColor Yellow
    Write-Host "    Set-NetConnectionProfile -InterfaceAlias '$publicAlias' -NetworkCategory Private" -ForegroundColor White
    Write-Host "  Ou vá em: Configurações do Windows -> Rede e Internet -> Wi-Fi -> Propriedades da rede -> Tipo de rede: Privada." -ForegroundColor Gray
} else {
    Write-Host "  [OK] Rede ativa configurada como Privada." -ForegroundColor Green
}

Write-Host ""

# 2. Criar ou atualizar a regra de entrada no Firewall
Write-Host "[2/3] Configurando regra de entrada no Firewall (Porta $Port, LocalSubnet)..." -ForegroundColor Yellow

$existingRule = Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue

if ($existingRule) {
    Write-Host "  -> Regra existente encontrada. Atualizando..." -ForegroundColor Gray
    Remove-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue
}

try {
    New-NetFirewallRule -DisplayName $RuleName `
                        -Description "Permite conexões de entrada do celular na rede local para o PC Media Control." `
                        -Direction Inbound `
                        -Action Allow `
                        -Protocol TCP `
                        -LocalPort $Port `
                        -RemoteAddress LocalSubnet `
                        -Profile Private, Domain `
                        -Enabled True | Out-Null

    Write-Host "  [OK] Regra '$RuleName' criada com sucesso!" -ForegroundColor Green
    Write-Host "       Protocolo: TCP | Porta: $Port | Origem: LocalSubnet | Perfis: Privado, Domínio" -ForegroundColor Gray
} catch {
    Write-Host "  [ERRO] Falha ao criar regra no Firewall: $_" -ForegroundColor Red
    exit 1
}

Write-Host ""

# 3. Informações adicionais (Wi-Fi AP isolation e Hotspot)
Write-Host "[3/3] Diagnóstico de rede e Wi-Fi:" -ForegroundColor Yellow
Write-Host "  - Se o celular não conseguir abrir a página mesmo com o firewall liberado," -ForegroundColor Gray
Write-Host "    sua rede Wi-Fi pode ter 'Isolamento de Clientes' (AP Isolation, comum em redes públicas/universitárias)." -ForegroundColor Gray
Write-Host "  - Plano B (Hotspot): ative o 'Hotspot móvel' do Windows (ou roteador Wi-Fi do celular)" -ForegroundColor Gray
Write-Host "    e conecte ambos os aparelhos na mesma rede do hotspot." -ForegroundColor Gray
Write-Host ""
Write-Host 'Configuração concluída com sucesso! Agora você pode rodar:' -ForegroundColor Green
Write-Host '  .\.venv\Scripts\python.exe -m host --lan' -ForegroundColor Cyan
Write-Host ""
