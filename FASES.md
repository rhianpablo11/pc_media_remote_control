# Fases — PC Media Control

**Fase atual: 1**

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
- [ ] Projeto `extension/` em Manifest V3 (`content script` + `service worker`) conectado ao host via WebSocket em `localhost`
- [ ] Validar na extensão se título e capa/miniatura podem ser lidos da página (`navigator.mediaSession` + fallback DOM) e registrar o resultado em `ARQUITETURA.md`
- [ ] Listar abas tocando com título, canal e miniatura, e controlar `play`/`pause`/`seek` por aba
- [ ] Volume por aba pela extensão (volume do elemento `<video>` e/ou silenciar a aba)
- [ ] Pular anúncio do YouTube (quando o botão existir)
- [ ] Abrir busca no YouTube / abrir URL a partir do celular

**Aceite:** com 2+ abas do YouTube tocando, controlo reprodução e volume de cada aba individualmente, pulo anúncio e abro vídeo novo sem tocar no notebook (sem duplicar sessões do `chrome.exe` no host).

## Fase 3 — Cliente PWA
- [ ] Projeto `client/` (Vite + React + TS + Tailwind) seguindo `DESIGN.md`
- [ ] Telas: Tocando agora, seletor de sessão, volume geral / por app / por aba
- [ ] Temas claro/escuro/automático
- [ ] Reconexão automática e estados de erro
- [ ] Host serve o build estático do cliente
- [ ] Manifest + ícones (instalável)

**Aceite:** UI completa funcionando no notebook, no tamanho de tela de celular.

## Fase 4 — Rede, descoberta e pareamento
- [ ] Host passa a escutar na LAN (somente rede privada) **junto com** o pareamento obrigatório
- [ ] Filtrar adaptadores virtuais (Hyper-V/WSL/VPN) ao escolher o IP da LAN
- [ ] Tratar o Perfil Público do firewall (orientar mudar Wi-Fi para Privada ou criar regra para executável/porta)
- [ ] QR code exibido pelo host (janela ou terminal) com URL + token de uso único
- [ ] Token de longa duração no cliente; lista de dispositivos autorizados no host, com revogação
- [ ] Publicação mDNS (`_pcmedia._tcp`) e teste de resolução `.local` no Chrome do Android
- [ ] Rejeição de comandos de dispositivos não pareados (com teste)
- [ ] Guia curto no `README.md`: firewall (Perfil Público -> Privado), diagnóstico de Wi-Fi com isolamento de clientes (AP isolation) e plano B de hotspot

**Aceite:** do celular Android real, escaneio o QR, pareio e controlo o notebook; um segundo aparelho sem pareamento não consegue controlar nada.

## Fase 5 — App de bandeja e instalação (Windows)
- [ ] Ícone na bandeja: status, mostrar QR, dispositivos pareados, sair
- [ ] Iniciar com o Windows (opcional, configurável)
- [ ] Empacotamento em executável (PyInstaller ou equivalente)
- [ ] `README.md` com instalação e uso

**Aceite:** instalo no notebook, reinicio, e o controle continua funcionando sem abrir terminal.

## Fase 6 — Modo touchpad/teclado remoto (opcional)
- [ ] Tela de touchpad (mover cursor, clique, rolagem) e teclado de texto
- [ ] Ligado/desligado nas configurações por segurança

## Futuro
- Linux (MPRIS), macOS, cliente iOS testado, app nativo, múltiplos notebooks.
