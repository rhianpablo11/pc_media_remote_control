# PC Media Control

Transforme seu notebook ou PC (Windows) numa central de mídia controlada pelo celular via rede local (Wi-Fi), sem necessidade de servidores externos, nuvem ou cadastro de contas.

---

## Recursos Principais

- **Controle Unificado de Mídia:**
  - **Spotify e apps do Windows:** controle via GSMTC (Global System Media Transport Controls) nativo do Windows.
  - **Google Chrome multi-abas:** extensão MV3 que lista cada aba do YouTube individualmente, permitindo play, pause, seek (±10s), pular anúncio (clicando no botão nativo "Pular"), alternância de tela cheia e volume individual por aba.
  - **Fallback global:** suporte a players sem GSMTC (ex.: VLC 3.x) via teclas multimídia globais e volume por processo via Core Audio.
- **Busca e Troca de Vídeos pelo Celular:**
  - Aba **"Buscar"** dedicada no celular: pesquise vídeos do YouTube diretamente sem necessidade de API key ou servidores externos.
  - Resultados em cards ricos com miniatura 16:9, canal, duração/ao vivo e contagem de visualizações.
  - Ações rápidas: "Tocar agora" (reutiliza a aba aberta ou ativa do YouTube no PC) e "Nova aba".
  - Controle de **Tela Cheia (Fullscreen)**: botão toggle na tela "Tocando agora", opção ao tocar o vídeo e persistência automática de tela cheia ao trocar de vídeo.
  - Histórico de buscas recentes salvo localmente no celular (localStorage) com chips clicáveis.
- **Mixer de Volume:**
  - Volume mestre do sistema com mute.
  - Volume e silenciamento individual para cada aba do Chrome.
  - Volume por aplicativo Windows ativo via Core Audio (`pycaw`).
- **Mouse (Touchpad) e Teclado Remoto:**
  - Aba **"Controle"** com touchpad multi-gesto (mover cursor com sensibilidade ajustável, toque para clique esquerdo, 2 dedos para clique direito e rolagem, barra lateral de rolagem e trava de arrastar) e teclado remoto em modo envio em lote ou tempo real (com acentuação em português e atalhos como `Alt+Tab`, `Copiar`/`Colar`, setas e `Win`).
  - **Segurança por padrão:** o controle de mouse/teclado começa **desativado por padrão**, podendo ser ligado/desligado no aplicativo, no menu da bandeja do Windows ou em `/pair`.
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

A extensão faz a ponte com as abas do YouTube e outros reprodutores no Chrome:

1. **Pela bandeja:** Clique com o botão direito no ícone do aplicativo na bandeja do Windows e selecione **"🧩 Abrir pasta da extensão..."**. (Os arquivos são mantidos de forma persistente em `%LOCALAPPDATA%\PCMediaControl\extension`).
   - *Alternativa manual:* Use a pasta `extension/` deste repositório.
2. Abra o Chrome e acesse `chrome://extensions`.
3. No canto superior direito, ative o interruptor **"Modo do desenvolvedor"**.
4. Clique no botão **"Carregar sem compactação"** (Load unpacked).
5. Selecione a pasta da extensão aberta no passo 1.
6. O ID determinístico gerado pela extensão será:
   `dcnkokmkhlcocfengaobkeacnbdjdcfa`

---

## Executando o Servidor

Você pode executar o PC Media Control de duas formas: usando o executável independente (`PCMediaControl.exe`) ou via script Python no ambiente virtual.

### Opção 1: Executável Independente (Recomendado)

O executável inicia diretamente na bandeja do sistema (junto ao relógio do Windows), sem abrir janela preta de terminal:

1. Dê um duplo clique em `PCMediaControl.exe` (ou execute via linha de comando).
2. O ícone do projeto aparecerá na área de notificação da barra de tarefas.
3. Se você executar o arquivo novamente com o app já rodando, a segunda instância detecta a trava única e abre automaticamente a tela de pareamento no navegador padrão.

> **Como compilar o executável:**
> ```powershell
> .\.venv\Scripts\python.exe scripts\build_exe.py
> ```
> O executável será gerado em `dist/PCMediaControl.exe` já empacotando o cliente web, a extensão, os ícones e os recursos estáticos.

---

### Opção 2: Via Ambiente Virtual Python

```powershell
# Execução padrão (LAN ativa + Ícone na bandeja do sistema):
.\.venv\Scripts\python.exe -m host

# Execução apenas no terminal (sem ícone na bandeja):
.\.venv\Scripts\python.exe -m host --no-tray

# Execução restrita estritamente ao computador (loopback 127.0.0.1):
.\.venv\Scripts\python.exe -m host --local-only
```

Ao iniciar pelo terminal com a LAN ativa, o console exibirá:
1. O IP da rede local selecionado (ex.: `192.168.15.4`).
2. A URL de pareamento com o código de uso único.
3. Um **PIN de 6 dígitos** alternativo (expira em 5 minutos).
4. O **QR Code** impresso em caracteres ASCII no próprio terminal.

---

## Ícone na Bandeja do Sistema (System Tray)

Ao clicar com o botão direito no ícone do aplicativo na bandeja do Windows, você tem acesso rápido a:

- **Status da Conexão:** exibe o IP e a porta local onde o servidor está atendendo (ex.: `Ativo na LAN (192.168.15.4:8765)`).
- **📱 Parear Celular (QR Code)...:** abre a página de pareamento (`/pair`) no navegador padrão com o QR Code e PIN de 6 dígitos.
- **🎵 Abrir Central de Mídia:** abre a interface principal (`/`) no navegador do computador.
- **🔒 Dispositivos Pareados:** lista os aparelhos autorizados e permite revogar o acesso de qualquer dispositivo com um clique.
- **🖱️ Mouse e Teclado Remoto:** ativa ou desativa a permissão do touchpad e teclado remoto (desativada por padrão por segurança).
- **Iniciar com o Windows:** ativa ou desativa a inicialização automática do aplicativo em segundo plano ao ligar o computador (via registro do usuário em `HKCU\...\Run`). Ao ativar, o executável é copiado para um local estável e persistente em `%LOCALAPPDATA%\PCMediaControl\PCMediaControl.exe` (protegendo a inicialização caso a pasta original seja movida ou sincronizada pelo OneDrive).
- **🧩 Abrir pasta da extensão...:** abre a pasta estável `%LOCALAPPDATA%\PCMediaControl\extension` no Explorer contendo a extensão pronta para ser carregada no Chrome.
- **📂 Abrir pasta de logs:** abre a pasta `%LOCALAPPDATA%\PCMediaControl\logs` onde os logs rotativos são gravados.
- **Sair:** encerra o servidor e os serviços de rede graciosamente.

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

### 2. Aviso do Firewall do Windows na Primeira Execução

Na primeira vez que você executar o aplicativo (ou o Python) com a rede LAN ativada, o Windows Defender exibirá a caixa de diálogo:
> **"O Firewall do Windows Defender bloqueou alguns recursos deste aplicativo"**

1. Marque a caixa de seleção: **"Redes privadas, como rede doméstica ou de trabalho"**.
2. **Desmarque** a caixa de seleção: **"Redes públicas, como as de aeroportos ou cafeterias"** (por segurança).
3. Clique em **"Permitir acesso"**.

---

### 3. Liberar o Firewall via Script (Alternativa Automática)

Se a janela do firewall não apareceu ou foi fechada por engano, você pode criar a regra correta com um clique:

- **Via duplo clique (Mais fácil):**
  Dê um duplo clique no arquivo `scripts\allow_firewall.cmd`. Ele solicitará permissão de Administrador (UAC) e criará a regra no Firewall automaticamente.
- **Ou pelo PowerShell como Administrador:**
  ```powershell
  Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope Process
  .\scripts\allow_firewall.ps1
  ```
Esse script cria uma regra de entrada no Firewall do Windows restrita exclusivamente à sua sub-rede local (`RemoteAddress LocalSubnet`), sem expor o computador para a internet.

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
