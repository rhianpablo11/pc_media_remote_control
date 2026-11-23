# PC Media Control

Transforme seu PC ou notebook Windows em uma central de mídia controlada diretamente pelo celular na mesma rede Wi-Fi — **100% local**, sem nuvem, sem servidores externos, sem cadastro de contas e sem telemetria.

---

## Sumário

- [Recursos Principais](#recursos-principais)
- [Arquitetura e Estrutura do Projeto](#arquitetura-e-estrutura-do-projeto)
- [Instalação Rápida (Usuário Final — Windows)](#instalação-rápida-usuário-final--windows)
- [Como Usar](#como-usar)
- [Instalar no Celular como App (PWA / Tela Inicial)](#instalar-no-celular-como-app-pwa--tela-inicial)
- [Firewall, Rede Local e Diagnóstico](#firewall-rede-local-e-diagnóstico)
- [Segurança e Privacidade](#segurança-e-privacidade)
- [Desenvolvimento, Testes e Releases](#desenvolvimento-testes-e-releases)

---

## Recursos Principais

| Área | O que faz |
| --- | --- |
| **Controle Unificado de Mídia** | Controla apps nativos do Windows (Spotify, etc.) via **GSMTC**, múltiplas abas de áudio/vídeo no Google Chrome via extensão MV3 (sem duplicar sessões) e players sem GSMTC (como VLC 3.x) por teclas globais de mídia. |
| **Busca no YouTube sem API Key** | Aba **Buscar** dedicada no celular para pesquisar vídeos no YouTube pela sessão do Chrome, exibir cards com capa 16:9, canal, duração/`AO VIVO` e visualizações, escolher **Tocar agora** ou **Nova aba** e salvar histórico local de buscas no celular. |
| **Tela Cheia e Anúncios** | Botão para alternar **Tela cheia** na tela **Tocando**, opção de abrir vídeos já em tela cheia com restauração automática ao trocar de vídeo e botão **Pular anúncio** quando um anúncio está ativo no YouTube. |
| **Mixer de Volume Completo** | Controle em tempo real do **Volume Geral** do Windows, volume e silenciamento individual por **aba do Chrome** e volume por **aplicativo Windows** ativo via Core Audio (`pycaw`). |
| **Touchpad e Teclado Remoto** | Aba **Controle** com touchpad redimensionável (`P`/`M`/`G`/`Max` + alça de ajuste livre), 5 níveis de sensibilidade (`0.6x` a `3.0x`), gestos de 1 e 2 dedos, rolagem normal/invertida, trava de arrastar, duplo clique e clique do meio; teclado em lote ou tempo real (com acentuação) e **Atalhos do Windows** (`Bloquear PC`, `Dispositivos`, `Projetar (TV)`, `Saída de Som`, `Área Trab.`, `Alt+Tab`, edição). |
| **Espelho Leve da Tela** | Card opcional (**Desligado** por padrão) na aba **Controle** para ver a tela do PC ao vivo em JPEG (`Eco` / `Normal` / `Fluido`), dar **zoom** (`1.0x`–`3.5x` com pinça), trocar de monitor, expandir em **tela cheia real** com **modo paisagem (Girar 90°)** e HUD ocultável, além dos modos **`Toque`**, **`Cursor`** (mouse de precisão sobre a imagem) e **`Só ver`**. |
| **Acesso Remoto via Tailscale (opcional)** | Modo opt-in desligado por padrão (bandeja do Windows, `/pair#tailscale` ou `--tailscale`) para operar o PC fora da rede Wi-Fi doméstica pela sua rede privada Tailscale, mantendo pareamento obrigatório e compatibilidade com `tailscale serve` HTTPS. |
| **Interface Mobile-First (PWA)** | App React + TypeScript + Tailwind com temas **Claro**, **Escuro** e **Automático**, alvos de toque de pelo menos `44px`, reconexão automática e leitura fluida com uma mão. |
| **Bandeja do Sistema e Autostart** | Roda em segundo plano junto ao relógio do Windows com menu rápido para QR Code, dispositivos pareados, extensão Chrome, logs e opção **Iniciar com o Windows**. |

---

## Arquitetura e Estrutura do Projeto

```text
+-----------------------+       HTTP + WebSocket (LAN)       +-----------------------------------+
|  Celular (Navegador)  | <================================> |  Host Python (FastAPI / Uvicorn)  |
|  PWA React + Tailwind |     Pareamento QR / PIN + Token    |  Porta 8765 · mDNS _pcmedia._tcp  |
+-----------------------+                                    +-----------------------------------+
                                                                |               |               |
                                         WinRT GSMTC / pycaw ---+               |               +--- Win32 SendInput
                                                                                v
                                                                 Extensão Chrome MV3 (WebSocket localhost)
                                                                 Abas YouTube/HTML5 · Busca · Fullscreen
```

```text
pc_media_control/
├── host/                 # Servidor FastAPI, pareamento, rede/mDNS, bandeja Windows e entrada remota
├── client/               # Interface mobile PWA (React + TypeScript + Tailwind v4 via Vite)
├── extension/            # Extensão Google Chrome Manifest V3 (ponte multi-aba e busca YouTube)
├── scripts/              # Utilitários de firewall (allow_firewall.cmd/.ps1), build do .exe e spikes
├── assets/               # Ícones do aplicativo e da bandeja do sistema
├── tests/                # Testes automatizados Python (pytest) e helpers da extensão (node:test)
└── .github/workflows/    # Workflows de CI e geração automática de Release no GitHub
```

---

## Instalação Rápida (Usuário Final — Windows)

**Requisitos:** Windows 10/11 (x64), Google Chrome instalado no PC e celular conectado na mesma rede Wi-Fi.

### Passo 1 — Baixar na aba Releases

1. Acesse a seção **Releases** do repositório no GitHub e baixe o **`PCMediaControl.exe`**.
2. Arquivos disponíveis em cada release:
   - **`PCMediaControl.exe`** — Executável autônomo completo (servidor local, interface mobile, bandeja do Windows e extensão Chrome embutida).
   - **`PCMediaControl-extension.zip`** — Cópia avulsa da pasta da extensão Chrome (opcional; o próprio `.exe` já extrai a extensão automaticamente na primeira execução).
   - **`PCMediaControl-firewall-helper.zip`** — Scripts auxiliares (`allow_firewall.cmd` e `allow_firewall.ps1`) caso o aviso de Firewall não apareça ou seja fechado por engano.
   - **`SHA256SUMS.txt`** — Checksums SHA-256 para conferir a integridade dos arquivos baixados.

### Passo 2 — Executar e liberar o Firewall

1. Dê um duplo clique em **`PCMediaControl.exe`**.
   - *Nota do Windows SmartScreen:* como o binário não possui assinatura comercial paga, o Windows Defender pode mostrar *"O Windows protegeu o computador"*. Clique em **Mais informações** → **Executar assim mesmo**.
   - Se o app já estiver aberto, executar novamente abrirá a tela de pareamento no navegador.
2. Na primeira execução com rede LAN ativa, o Firewall do Windows Defender perguntará se deseja permitir acesso:
   - Marque **somente** *"Redes privadas, como rede doméstica ou de trabalho"*.
   - **Desmarque** *"Redes públicas"* e clique em **Permitir acesso**.
3. O ícone do **PC Media Control** aparecerá na bandeja do sistema (junto ao relógio do Windows).

### Passo 3 — Carregar a extensão no Google Chrome (arrastar e soltar)

> **Por que não instala automaticamente sem abrir o Chrome?** Por política de segurança, o Google Chrome no Windows bloqueia instalação silenciosa fora da Chrome Web Store (registros locais e `--load-extension`). Se no futuro quiser instalação com 1 clique pela loja sem *Modo do desenvolvedor*, basta publicar a extensão como **Não listada (*Unlisted*)** na Chrome Web Store.

Para deixar a instalação local quase imediata sem precisar procurar pastas ocultas em `AppData`:

1. Clique com o botão direito no ícone do app na bandeja do Windows e escolha **`🧩 Abrir pasta da extensão...`**.
   - Isso abre automaticamente o assistente guiado **`/pair#extensao`** no navegador, copia o caminho da pasta para sua área de transferência e abre o Windows Explorer com a pasta **`extension`** já selecionada (`%LOCALAPPDATA%\PCMediaControl\extension`).
2. Na aba do assistente no Chrome, clique em **Copiar `chrome://extensions`**, cole na barra de endereços do Chrome e ative o interruptor **Modo do desenvolvedor** (canto superior direito).
3. **Arraste a pasta `extension`** do Explorer direto para dentro da aba `chrome://extensions` *(ou clique em **Carregar sem compactação** e cole o caminho já copiado com `Ctrl+V`)*.
4. A página do assistente detecta a conexão automaticamente e muda o selo para **Conectada** (ID fixo: `dcnkokmkhlcocfengaobkeacnbdjdcfa`).

### Passo 4 — Parear o celular e (opcional) iniciar com o Windows

1. Clique com o botão direito no ícone da bandeja → **`📱 Parear Celular (QR Code)...`** para abrir `/pair` no computador.
2. Aponte a câmera do celular para o QR Code (ou abra `http://<IP-DO-PC>:8765` no navegador do celular e digite o **PIN de 6 dígitos** exibido na tela).
3. *(Opcional)* No menu da bandeja, ative **`Iniciar com o Windows`**. O executável será copiado para um caminho estável em `%LOCALAPPDATA%\PCMediaControl\PCMediaControl.exe` e registrado em `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`.

---

## Como Usar

### Abas do aplicativo no celular

1. **Tocando:** exibe capa/miniatura, título, canal/artista, status em tempo real, barra de progresso, **Play/Pause**, **±10s**, **Anterior/Próximo**, **Pular anúncio** (quando há anúncio ativo), toggle de **Tela cheia**, seletor de **Sessões** (alternar entre abas do Chrome e apps do Windows) e **Volume Geral**.
2. **Buscar:** campo de busca no YouTube sem precisar olhar o monitor, resultados com miniatura, canal, duração/`AO VIVO` e visualizações, botões **Tocar agora** (reaproveita a aba controlada ou abre uma nova) e **Nova aba**, opção **Abrir vídeo em tela cheia** e histórico recente salvo localmente no aparelho.
3. **Volume:** controle do **Volume Geral**, slider e mute de cada **aba do Chrome** individualmente e de cada **aplicativo Windows** ativo.
4. **Controle:** exibe o card opcional **Espelho da Tela** (desligado por padrão — toque em **Ver tela** para acompanhar o monitor ao vivo em **Eco**, **Normal** ou **Fluido**, dar **zoom (`1.0x`–`3.5x`)** com os botões ou gesto de pinça, trocar de monitor, abrir **tela cheia real** com **Girar** para ver deitado e **Ocultar** barra de controles, e alternar entre **`Toque`**, **`Cursor`** de precisão e **`Só ver`**) acima dos controles separados de **Touchpad** e **Teclado Remoto**. Por segurança, o controle remoto de entrada começa bloqueado — ative pela própria tela (**Ativar Mouse e Teclado**), pela aba **Mais** ou pela bandeja do Windows. O touchpad oferece 5 sensibilidades (`0.6x`–`3.0x`), presets de altura (`P`/`M`/`G`/`Max`) mais alça de redimensionamento livre, botões rápidos (**Clique Esq.**, **Arrastar/Soltar**, **Clique Dir.**, **Duplo Clique**, **Clique Meio**, **Rolagem Normal/Invertida**), teclado em **Enviar texto** ou **Tempo real** e seção **Atalhos do Windows** dividida em **Sistema** (`Dispositivos`, `Projetar (TV)`, `Saída de Som`, `Telas`, `Painel Rápido`, `Transmitir`, `Arquivos`, `Gerenciador`, `Bloquear PC` com confirmação em 2 toques), **Janelas** (`Área Trab.`, `Janelas`, `Minimizar`, `Maximizar`, `Atualizar (F5)`, `Fechar App`) e **Edição**.
5. **Mais:** colar uma URL qualquer para abrir no Chrome, teclas globais de fallback (VLC), interruptor de segurança do controle remoto, **Diagnóstico de Conexão** (URL WS, RTT, latência do host vs Wi-Fi), lista de **Dispositivos Pareados** com revogação imediata e escolha de tema (**Automático**, **Claro**, **Escuro**).

### Menu na Bandeja do Sistema (Windows)

Ao clicar com o botão direito no ícone perto do relógio:

- **Status:** mostra o IP e porta ativos (ex.: `Status: Ativo na LAN (192.168.15.4:8765)`).
- **`📱 Parear Celular (QR Code)...`:** abre `/pair` localmente para gerar ou ler QR Code e PIN.
- **`🎵 Abrir Central de Mídia`:** abre a interface web principal no navegador do PC.
- **`🔒 Dispositivos Pareados`:** exibe os aparelhos autorizados e permite revogação em `/pair`.
- **`🖱️ Mouse e Teclado Remoto`:** liga ou desliga a permissão de entrada remota.
- **`🌐 Acesso Remoto (Tailscale)`:** ativa ou desativa o acesso opcional fora da rede local pelo seu IP/MagicDNS Tailscale.
- **Iniciar com o Windows:** habilita/desabilita autostart estável em `%LOCALAPPDATA%\PCMediaControl\PCMediaControl.exe`.
- **`🧩 Abrir pasta da extensão...`:** abre `%LOCALAPPDATA%\PCMediaControl\extension` com instruções de instalação (`LEIA-ME.txt`).
- **`📂 Abrir pasta de logs`:** abre `%LOCALAPPDATA%\PCMediaControl\logs` com os logs rotativos.
- **Sair:** encerra servidor, anúncio mDNS e processos auxiliares com limpeza.

---

## Instalar no Celular como App (PWA / Tela Inicial)

O cliente já inclui `manifest.webmanifest`, `sw.js` e ícones PNG configurados para modo `standalone`. O comportamento varia conforme o sistema do celular por conta do acesso via HTTP na rede local (`http://<IP-DO-PC>:8765`):

- **iPhone / iPad (Safari):**
  1. Abra `http://<IP-DO-PC>:8765` no Safari após parear.
  2. Toque no botão **Compartilhar** → **Adicionar à Tela de Início**.
  3. O atalho abre a interface em modo **tela cheia (`standalone`)**, sem barra de endereço do navegador.
- **Android (Google Chrome):**
  - *Padrão via HTTP:* toque no menu **`⋮`** → **Adicionar à tela inicial**. Como o servidor roda em HTTP puro na rede local (sem certificado HTTPS confiável no Android), o Chrome cria um **atalho Web** (que abre com a barra superior do navegador) em vez do banner nativo *"Instalar aplicativo"*, pois navegadores Chromium exigem *Secure Context* (HTTPS ou `localhost`) para instalação PWA completa com Service Worker ativo.
  - *Opcional para entusiastas (PWA completo sem HTTPS):* se o seu PC usa IP fixo reservado no roteador (ex.: `http://192.168.15.10:8765`), você pode acessar `chrome://flags/#unsafely-treat-insecure-origin-as-secure` no Chrome do celular, adicionar essa origem e reiniciar o navegador para habilitar o prompt completo de instalação PWA.

---

## Firewall, Rede Local e Diagnóstico

### 1. Diagnóstico rápido (`doctor`)

Se estiver rodando pelo ambiente Python, o comando abaixo diagnostica adaptadores físicos vs virtuais, perfil da rede, regras de firewall, porta `8765` e alertas de isolamento de clientes:

```powershell
.\.venv\Scripts\python.exe -m host doctor
```

### 2. Liberar Firewall com um clique

Se o aviso do Firewall do Windows não apareceu ou foi bloqueado por engano:

- **Para quem baixou pela Release:** extraia `PCMediaControl-firewall-helper.zip` e execute `allow_firewall.cmd` (dê duplo clique e aceite a elevação UAC).
- **Para quem clonou o repositório:** execute `scripts\allow_firewall.cmd` ou, no PowerShell como Administrador:

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope Process
.\scripts\allow_firewall.ps1
```

O script cria uma regra de entrada na porta TCP `8765` restrita exclusivamente à sub-rede local (`RemoteAddress LocalSubnet`) nos perfis **Privado** e **Domínio**, sem expor o PC à internet.

### 3. Perfil Público vs Privado

Redes Wi-Fi marcadas como **Público** no Windows bloqueiam conexões de entrada. Para mudar para **Privada**:

- **Configurações do Windows:** **Rede e Internet** → **Wi-Fi** → clique na sua rede → selecione **Rede Privada**.
- **PowerShell (Administrador):**

```powershell
Set-NetConnectionProfile -InterfaceAlias 'Wi-Fi' -NetworkCategory Private
```

### 4. Wi-Fi com Isolamento de Clientes (AP Isolation) e Plano B via Hotspot

Em redes corporativas, públicas ou universitárias, o roteador pode bloquear comunicação entre dispositivos conectados ao mesmo Wi-Fi (*AP Isolation*).

- **Sintoma:** `http://<IP-DO-PC>:8765` não abre no celular mesmo com a rede em **Privada** e o Firewall liberado.
- **Plano B (Hotspot Móvel):** ative o **Hotspot móvel** do Windows (ou o roteador Wi-Fi do celular), conecte PC e celular nessa rede direta e gere um novo QR Code pelo menu da bandeja (`📱 Parear Celular (QR Code)...`).

### 5. Acesso remoto fora da Wi-Fi (Tailscale — opcional)

O app funciona **apenas na rede Wi-Fi local por padrão**. Se quiser controlar o PC ou ver o espelho da tela fora de casa pela internet de forma privada (WireGuard sem abrir portas no roteador):

1. Instale e entre no [Tailscale](https://tailscale.com/) no PC Windows e no celular usando a mesma conta.
2. No PC, ative **`🌐 Acesso Remoto (Tailscale)`** no ícone da bandeja (ou na seção correspondente em `/pair#tailscale`, ou iniciando com `--tailscale`).
3. Abra `http://<IP-TAILSCALE-DO-PC>:8765` no celular e pareie com o PIN/QR Code exibido em `/pair`.
4. *(Opcional — HTTPS e PWA nativo no Android)*: caso seu *tailnet* tenha HTTPS habilitado, rode no PC:
   ```powershell
   tailscale serve --bg 8765
   ```
   E acesse `https://<SEU-PC>.<SUA-TAILNET>.ts.net` no celular. Mesmo via proxy local do `tailscale serve`, o host detecta cabeçalhos de proxy e mantém o pareamento obrigatório e `/pair` bloqueado fora do PC local.

---

## Segurança e Privacidade

- **Pareamento obrigatório na LAN:** nenhuma requisição vinda da rede local controla mídia, volume ou mouse sem token válido emitido por QR Code ou PIN de 6 dígitos (uso único, expiração de 5 minutos e bloqueio temporário após tentativas inválidas).
- **Armazenamento seguro de tokens:** apenas o hash SHA-256 dos tokens é persistido em `%LOCALAPPDATA%\PCMediaControl\devices.json`; dispositivos revogados têm suas conexões WebSocket fechadas imediatamente com código `4001`.
- **Proteção contra DNS rebinding e origens externas:** validação estrita do cabeçalho HTTP `Host` e do cabeçalho `Origin` em `/ws` (apenas o próprio host) e `/ws/extension` (apenas a extensão Chrome de ID `dcnkokmkhlcocfengaobkeacnbdjdcfa`).
- **Controle remoto desligado por padrão:** touchpad e teclado remoto iniciam desativados em `%LOCALAPPDATA%\PCMediaControl\settings.json`.
- **Rede recomendada:** como o tráfego local utiliza HTTP/WebSocket na LAN sem TLS, utilize o aplicativo apenas em redes Wi-Fi privadas protegidas por **WPA2/WPA3** ou via hotspot pessoal.

---

## Desenvolvimento, Testes e Releases

### Pré-requisitos (Ambiente Dev)

- Windows 10/11 (x64)
- Python 3.12+ nativo no Windows (sem WSL)
- Node.js 22+ e npm

### Preparar ambiente local

```powershell
git clone https://github.com/rhianpablo11/pc_media_remote_control.git
cd pc_media_remote_control

# Ambiente Python
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\pip.exe install -r host/requirements.txt pytest ruff

# Frontend PWA React
npm --prefix client ci
npm --prefix client run build
```

### Executar em modo desenvolvimento

```powershell
# Servidor padrão na LAN + ícone na bandeja
.\.venv\Scripts\python.exe -m host

# Apenas no terminal (sem bandeja)
.\.venv\Scripts\python.exe -m host --no-tray

# Restrito ao próprio computador (127.0.0.1)
.\.venv\Scripts\python.exe -m host --local-only

# Modo dev liberando também o servidor Vite (http://localhost:5173)
.\.venv\Scripts\python.exe -m host --dev --no-tray
```

### Executar toda a suíte de lint, testes e build

```powershell
# Python (lint + testes)
.\.venv\Scripts\ruff.exe check .
.\.venv\Scripts\pytest.exe -v

# Helpers da extensão Chrome (Node test runner)
node --test tests/test_extension_helpers.mjs

# Cliente PWA (TypeScript + Vitest + build de produção)
npm --prefix client run lint
npm --prefix client test
npm --prefix client run build
```

### Gerar o executável localmente

```powershell
.\.venv\Scripts\python.exe scripts\build_exe.py
```

O binário final é gerado em `dist/PCMediaControl.exe` (via [pc_media_control.spec](pc_media_control.spec)).

### Automação no GitHub (CI e Releases)

O repositório conta com dois workflows em `.github/workflows/` rodando em `windows-latest`:

- **[`.github/workflows/ci.yml`](.github/workflows/ci.yml):** roda automaticamente em todo `push` e `pull_request` para a branch `main`, validando `ruff`, `pytest`, testes Node da extensão e lint/test/build do cliente PWA.
- **[`.github/workflows/release.yml`](.github/workflows/release.yml):** roda todo o pacote de testes, executa `scripts/build_exe.py`, empacota `PCMediaControl.exe`, `PCMediaControl-extension.zip`, `PCMediaControl-firewall-helper.zip` e `SHA256SUMS.txt` e publica uma **GitHub Release** com os anexos prontos para download.
  - **Execução em 1 clique no GitHub (SemVer automático):** na aba **Actions** → **Release Windows Executable** → **Run workflow**, escolha o tipo de incremento em **`bump`**:
    - `patch` *(padrão)*, `minor` ou `major` — cria automaticamente a próxima tag `vX.Y.Z` (iniciando em `v1.0.0` se ainda não houver tags) e publica a **GitHub Release** correspondente;
    - `custom` — usa a tag informada no campo `tag` (ex.: `v1.2.0-beta.1`);
    - `artifact-only` — gera e disponibiliza o artefato de teste (`pc-media-control-windows-x64`) por 14 dias sem publicar Release.
  - **Publicação direta por tag Git:** também é possível disparar criando e enviando uma tag começando com `v`:
    ```powershell
    git tag v1.0.0
    git push origin v1.0.0
    ```
