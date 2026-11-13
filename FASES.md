# Fases — PC Media Control

**Fase atual: 5**

Regra: concluir a fase, marcar os checkboxes, commitar, parar e reportar. Só avançar quando o usuário autorizar.

---

## Fase 0 — Spike de viabilidade (Windows)
Objetivo: descobrir o que o Windows realmente nos entrega, antes de construir qualquer coisa.
- [x] Script `scripts/spike_media.py` que lista todas as sessões GSMTC (app, título, artista, status, posição, duração) e permite play/pause/next/previous/seek por sessão
- [x] Testar com: YouTube em 2 abas do Chrome, VLC, Spotify *(Spotify e VLC 3.0.23 testados; teste prático do usuário com 2 abas do YouTube no Chrome normal confirmou apenas 1 sessão no GSMTC, refutando a hipótese de controle multi-aba via GSMTC)*
- [x] Script `scripts/spike_volume.py` que lista sessões de áudio por app e altera o volume de cada uma e o volume mestre
- [x] Preencher os checkboxes da seção "Hipóteses a validar" em `ARQUITETURA.md` com o resultado real
- [x] Relatório curto em `ARQUITETURA.md` (seção Decisões): o que funciona, o que não funciona, impacto no plano

**Aceite:** hipóteses respondidas com evidência; plano ajustado com base nos resultados.

## Fase 1 — Host núcleo + provedores (Windows)
- [x] Projeto `host/` com FastAPI + WebSocket, escutando só em `127.0.0.1`
- [x] Abstração de provedores de sessão (`SessionProvider`): `WindowsProvider` (GSMTC + `pycaw` + fallback de teclas de mídia para Spotify, VLC e demais apps) e `ChromeExtensionProvider` (unificando sessões numa lista com `id` contendo a origem e ocultando sessões GSMTC de `chrome.exe` quando a extensão estiver conectada)
- [x] Protocolo v1 (`state`/`command`/`volume`/`select`) com testes automatizados (provedor simulado nos testes)
- [x] Cliente de teste em linha de comando ou página mínima *(página mínima servida em `/` via `host/static/index.html`)*

**Aceite:** pelo navegador do próprio notebook, consigo ver sessões unificadas e controlar mídia e volume.

## Fase 2 — Extensão do Chrome (MV3)
- [x] Projeto `extension/` em Manifest V3 (`content script` + `service worker`) conectado ao host via WebSocket em `localhost` *(com validação estrita de `Origin` em `/ws` e `/ws/extension`, ID fixo via `"key"` em `manifest.json`)*
- [x] Validar na extensão se título e capa/miniatura podem ser lidos da página (`navigator.mediaSession` + fallback DOM) e registrar o resultado em `ARQUITETURA.md` *(implementada leitura `ISOLATED` + ponte `MAIN` + seletores DOM YouTube/genéricos + diagnóstico no `popup.html`, com arquitetura e restrições MV3 registradas em `ARQUITETURA.md`; validação ao vivo no Chrome via `chrome://extensions` pendente de execução no navegador do usuário)*
- [x] Listar abas tocando com título, canal e miniatura, e controlar `play`/`pause`/`seek` por aba *(inclui `±10s` via `seek_relative` e `next`/`previous` quando disponíveis)*
- [x] Volume por aba pela extensão (volume do elemento `<video>` e/ou silenciar a aba) *(slider no `<video>`/`<audio>` + `chrome.tabs.update({ muted })`)*
- [x] Pular anúncio do YouTube (quando o botão existir) *(clica apenas no botão visível/habilitado "Pular" quando aparece; sem bloqueio de anúncios)*
- [x] Abrir busca no YouTube / abrir URL a partir do celular *(mensagem `open` com validação `http://`/`https://` e card de teste na página do host)*

**Aceite:** com 2+ abas do YouTube tocando, controlo reprodução e volume de cada aba individualmente, pulo anúncio e abro vídeo novo sem tocar no notebook (sem duplicar sessões do `chrome.exe` no host).

## Fase 3 — Cliente PWA
- [x] Projeto `client/` (Vite + React + TS + Tailwind) seguindo `DESIGN.md`
- [x] Telas: Tocando agora, seletor de sessão, volume geral / por app / por aba *(e aba Mais com ações da extensão, teclas globais de fallback e seleção de tema)*
- [x] Temas claro/escuro/automático *(variáveis CSS em `client/src/index.css` com `prefers-color-scheme` e troca manual persistida)*
- [x] Reconexão automática e estados de erro *(reconexão exponencial + retomada em `visibilitychange`/`online`, estado offline com último cache, tela de não pareado e toast de erro)*
- [x] Host serve o build estático do cliente *(servindo `client/dist/` em `/` com fallback em `/legacy-test` e origem Vite liberada só em `--dev`)*
- [x] Manifest + ícones (instalável) *(`manifest.webmanifest`, ícones PNG `192`/`512`/`apple-touch-icon` e `sw.js` incluídos; ressalva de atalho via HTTP na LAN documentada em `ARQUITETURA.md`)*

**Aceite:** UI completa funcionando no notebook, no tamanho de tela de celular.

## Fase 4 — Rede, descoberta e pareamento
- [x] Host passa a escutar na LAN (somente rede privada) **junto com** o pareamento obrigatório *(flag opt-in `--lan`, autenticação via primeiro frame WS ou Bearer HTTP, loopback mantido de confiança local)*
- [x] Filtrar adaptadores virtuais (Hyper-V/WSL/VPN) ao escolher o IP da LAN *(módulo `host/network.py` filtra Hyper-V, WSL, VirtualBox, VMware, Tailscale, etc. e prioriza Wi-Fi/Ethernet físico)*
- [x] Tratar o Perfil Público do firewall (orientar mudar Wi-Fi para Privada ou criar regra para executável/porta) *(script `scripts/allow_firewall.ps1` com regra `RemoteAddress LocalSubnet` + alerta no `python -m host doctor`)*
- [x] QR code exibido pelo host (janela ou terminal) com URL + token de uso único *(impressão ASCII no terminal ao rodar com `--lan` e página `/pair` com QR vetorial SVG sem PIL e PIN numérico de 6 dígitos com expiração de 5 min e rate-limiting de 5 tentativas)*
- [x] Token de longa duração no cliente; lista de dispositivos autorizados no host, com revogação *(store em `%LOCALAPPDATA%\PCMediaControl\devices.json` guardando apenas hash SHA-256; revogação fecha imediatamente conexões WS ativas com código 4001; UI de revogação na aba "Mais" do PWA e na página `/pair`)*
- [x] Publicação mDNS (`_pcmedia._tcp`) e teste de resolução `.local` no Chrome do Android *(publicação assíncrona com `zeroconf` no lifespan do host; QR Code e PIN usam IP como rota primária e `.local` como alternativa)*
- [x] Rejeição de comandos de dispositivos não pareados (com teste) *(16 testes automatizados em `tests/test_fase4_network_and_pairing.py` cobrindo rejeição de Origin, Host inválido [DNS rebinding], falta de token, token revogado e PIN inválido)*
- [x] Guia curto no `README.md`: firewall (Perfil Público -> Privado), diagnóstico de Wi-Fi com isolamento de clientes (AP isolation) e plano B de hotspot *(guia completo no `README.md` com instruções de execução, firewall, perfil privado, diagnóstico e hotspot)*

**Aceite:** do celular Android real, escaneio o QR, pareio e controlo o notebook; um segundo aparelho sem pareamento não consegue controlar nada.

## Fase 5 — App de bandeja e instalação (Windows)
- [x] Ícone na bandeja: status, mostrar QR, dispositivos pareados, sair *(implementado com `pystray` + `Pillow` em `host/tray.py`, exibindo IP/porta ativos, atalhos para `/pair` e `/`, submenu de dispositivos pareados com revogação, pasta de logs e encerramento limpo)*
- [x] Iniciar com o Windows (opcional, configurável) *(módulo `host/autostart.py` configurando chave `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` com toggle no menu da bandeja)*
- [x] Empacotamento em executável (PyInstaller ou equivalente) *(configurado `pc_media_control.spec` e script `scripts/build_exe.py` gerando `dist/PCMediaControl.exe` autônomo sem console com recursos embutidos, trava de instância única via Named Mutex Win32 e logs rotativos em `%LOCALAPPDATA%\PCMediaControl\logs`)*
- [x] `README.md` com instalação e uso *(seções detalhadas de execução via executável vs ambiente virtual, opções do menu de bandeja, autostart, compilação e diagnóstico)*

**Aceite:** instalo no notebook, reinicio, e o controle continua funcionando sem abrir terminal.

## Fase 6 — Modo touchpad/teclado remoto (opcional)
- [ ] Tela de touchpad (mover cursor, clique, rolagem) e teclado de texto
- [ ] Ligado/desligado nas configurações por segurança

## Futuro
- Linux (MPRIS), macOS, cliente iOS testado, app nativo, múltiplos notebooks.
