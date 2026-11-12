# PC Media Control

Transforme seu notebook ou PC (Windows) numa central de mídia controlada pelo celular via rede local (Wi-Fi), sem necessidade de servidores externos, nuvem ou cadastro de contas.

---

## Recursos Principais

- **Controle Unificado de Mídia:**
  - **Spotify e apps do Windows:** controle via GSMTC (Global System Media Transport Controls) nativo do Windows.
  - **Google Chrome multi-abas:** extensão MV3 que lista cada aba do YouTube individualmente, permitindo play, pause, seek (±10s), pular anúncio (clicando no botão nativo "Pular"), busca e volume individual por aba.
  - **Fallback global:** suporte a players sem GSMTC (ex.: VLC 3.x) via teclas multimídia globais e volume por processo via Core Audio.
- **Mixer de Volume:**
  - Volume mestre do sistema com mute.
  - Volume e silenciamento individual para cada aba do Chrome.
  - Volume por aplicativo Windows ativo via Core Audio (`pycaw`).
- **Interface Mobile-First (PWA):**
  - Desenvolvida em React + TypeScript + Tailwind seguindo o padrão de design limpo e fluido (estilo Apple).
  - Temas Claro, Escuro e Automático (baseado no sistema).
  - Alvos de toque generosos (mínimo de 44px) e feedback tátil em aparelhos compatíveis.
- **Segurança e Rede Local:**
  - Pareamento de uso único via **QR Code** ou **PIN de 6 dígitos** com expiração de 5 minutos e bloqueio temporário contra força bruta.
  - Autenticação obrigatória por token para conexões vindas da LAN (apenas aparelhos autorizados conseguem controlar o PC).
  - Proteção contra ataques de DNS rebinding via validação de cabeçalho `Host`.
  - Descoberta automática de rede via mDNS (`_pcmedia._tcp.local.`) com filtragem de adaptadores virtuais (Hyper-V, WSL, VPNs).

---

## Requisitos

- Windows 10/11 (arquitetura x64).
- Python 3.12+ nativo no Windows (com `.venv`).
- Google Chrome com a extensão do projeto instalada em `chrome://extensions`.
- Celular ou tablet conectado na mesma rede Wi-Fi do computador.

---

## Instalação e Configuração

### 1. Clonar e preparar o ambiente Python

```powershell
# No PowerShell (como usuário normal):
git clone https://github.com/rhian/pc_media_control.git
cd pc_media_control

# Criar e ativar o ambiente virtual nativo:
python -m venv .venv
.\.venv\Scripts\Activate.ps1

# Instalar dependências:
pip install -r host/requirements.txt
```

### 2. Carregar a extensão no Google Chrome

1. Abra o Chrome e acesse `chrome://extensions`.
2. No canto superior direito, ative o interruptor **"Modo do desenvolvedor"**.
3. Clique no botão **"Carregar sem compactação"** (Load unpacked).
4. Selecione a pasta `extension/` deste repositório.
5. O ID determinístico gerado pela extensão será:
   `kclphkiojphjbbomdfcpeffjljgmpcne`

---

## Executando o Servidor

### Modo Local (apenas no PC)
```powershell
.\.venv\Scripts\python.exe -m host
```
Acesse `http://127.0.0.1:8765` pelo navegador no computador.

### Modo LAN (para controlar pelo Celular)
```powershell
.\.venv\Scripts\python.exe -m host --lan
```
Ao iniciar, o terminal exibirá:
1. O IP da rede local selecionado (ex.: `192.168.15.4`).
2. A URL de pareamento com o código de uso único.
3. Um **PIN de 6 dígitos** alternativo (expira em 5 minutos).
4. O **QR Code** impresso em caracteres ASCII no próprio terminal.

Aponte a câmera do celular para o QR Code para abrir o aplicativo e concluir a autorização automaticamente.

---

## Firewall e Diagnóstico de Rede

### 1. Diagnóstico rápido (`doctor`)

Antes de conectar pela primeira vez, execute o utilitário de diagnóstico:
```powershell
.\.venv\Scripts\python.exe -m host doctor
```
Ele verifica:
- Adaptadores de rede físicos vs virtuais.
- Se o perfil de rede está como Privado ou Público.
- Regras existentes no Firewall do Windows.
- Conectividade da porta 8765.
- Alertas sobre isolamento de clientes (AP Isolation).

### 2. Liberar o Firewall do Windows

Para permitir que o celular acesse a porta 8765 apenas pela sua rede local, execute o script PowerShell como Administrador:
```powershell
# Abra o PowerShell como Administrador:
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope Process
.\scripts\allow_firewall.ps1
```
Esse script cria uma regra de entrada no Firewall do Windows restrita à sub-rede local (`RemoteAddress LocalSubnet`), protegendo o computador contra acessos externos.

### 3. Perfil de Rede: Público vs Privado

Se a sua rede Wi-Fi estiver configurada como **Perfil Público**, o Firewall do Windows bloqueará todas as conexões de entrada por padrão.
Para alterar para **Privada**:
- **Pelo Windows:** Configurações -> Rede e Internet -> Wi-Fi -> Clique na sua rede -> Selecione **"Rede Privada"**.
- **Ou pelo PowerShell (Administrador):**
  ```powershell
  Set-NetConnectionProfile -InterfaceAlias 'Wi-Fi' -NetworkCategory Private
  ```

### 4. Wi-Fi com Isolamento de Clientes (AP Isolation) & Plano B (Hotspot)

Em algumas redes Wi-Fi públicas, corporativas ou universitárias, o roteador ativa o recurso **AP Isolation** (isolamento de clientes), impedindo que aparelhos na mesma rede conversem entre si.
- **Sintoma:** O celular não consegue abrir `http://<ip_do_pc>:8765` mesmo após configurar o firewall.
- **Plano B (Hotspot Móvel):**
  1. No Windows, abra Configurações -> Rede e Internet -> **Hotspot móvel** e ative-o.
  2. Conecte o celular na rede Wi-Fi transmitida pelo notebook.
  3. Inicie o host com `.\.venv\Scripts\python.exe -m host --lan`.
  4. Escaneie o novo QR code e controle sem interferência de roteadores externos!

---

## Testes Automatizados

```powershell
# Testes unitários e de integração Python:
.\.venv\Scripts\pytest.exe -v

# Linter Python:
.\.venv\Scripts\ruff.exe check .

# Testes da extensão Chrome (Node.js):
node --test tests/test_extension_helpers.mjs

# Linter e testes do cliente PWA (React / Vitest):
npm --prefix client run lint
npm --prefix client test
npm --prefix client run build
```
