# Fases — PC Media Control

**Fase atual: 0**

Regra: concluir a fase, marcar os checkboxes, commitar, parar e reportar. Só avançar quando o usuário autorizar.

---

## Fase 0 — Spike de viabilidade (Windows)
Objetivo: descobrir o que o Windows realmente nos entrega, antes de construir qualquer coisa.
- [ ] Script `scripts/spike_media.py` que lista todas as sessões GSMTC (app, título, artista, status, posição, duração) e permite play/pause/next/previous/seek por sessão
- [ ] Testar com: YouTube em 2 abas do Chrome, VLC, Spotify
- [ ] Script `scripts/spike_volume.py` que lista sessões de áudio por app e altera o volume de cada uma e o volume mestre
- [ ] Preencher os checkboxes da seção "Hipóteses a validar" em `ARQUITETURA.md` com o resultado real
- [ ] Relatório curto em `ARQUITETURA.md` (seção Decisões): o que funciona, o que não funciona, impacto no plano

**Aceite:** hipóteses respondidas com evidência; usuário decide se o plano muda.

## Fase 1 — Host núcleo
- [ ] Projeto `host/` com FastAPI + WebSocket, escutando só em `127.0.0.1`
- [ ] `PlatformAdapter` (interface) + `WindowsAdapter` usando o que foi validado na Fase 0
- [ ] Protocolo v1 (state/command/volume/select) com testes automatizados (adapter simulado nos testes)
- [ ] Cliente de teste em linha de comando ou página mínima

**Aceite:** pelo navegador do próprio notebook, consigo ver sessões e controlar mídia e volume.

## Fase 2 — Cliente PWA
- [ ] Projeto `client/` (Vite + React + TS + Tailwind) seguindo `DESIGN.md`
- [ ] Telas: Tocando agora, seletor de sessão, volume por app
- [ ] Temas claro/escuro/automático
- [ ] Reconexão automática e estados de erro
- [ ] Host serve o build estático do cliente
- [ ] Manifest + ícones (instalável)

**Aceite:** UI completa funcionando no notebook, no tamanho de tela de celular.

## Fase 3 — Rede, descoberta e pareamento
- [ ] Host passa a escutar na LAN (somente rede privada) **junto com** o pareamento obrigatório
- [ ] QR code exibido pelo host (janela ou terminal) com URL + token de uso único
- [ ] Token de longa duração no cliente; lista de dispositivos autorizados no host, com revogação
- [ ] Publicação mDNS (`_pcmedia._tcp`)
- [ ] Rejeição de comandos de dispositivos não pareados (com teste)
- [ ] Guia curto de firewall/Wi-Fi com isolamento no `README.md`

**Aceite:** do celular Android real, escaneio o QR, pareio e controlo o notebook; um segundo aparelho sem pareamento não consegue controlar nada.

## Fase 4 — App de bandeja e instalação (Windows)
- [ ] Ícone na bandeja: status, mostrar QR, dispositivos pareados, sair
- [ ] Iniciar com o Windows (opcional, configurável)
- [ ] Empacotamento em executável (PyInstaller ou equivalente)
- [ ] `README.md` com instalação e uso

**Aceite:** instalo no notebook, reinicio, e o controle continua funcionando sem abrir terminal.

## Fase 5 — Extensão do Chrome
- [ ] Extensão MV3 conectada ao host via WebSocket em localhost
- [ ] Pular anúncio do YouTube (quando o botão existir)
- [ ] Abrir busca no YouTube / abrir URL a partir do celular
- [ ] Controle por aba (se a Fase 0 mostrou limitação no GSMTC)

**Aceite:** do celular, pulo anúncio e abro um vídeo novo sem tocar no notebook.

## Fase 6 — Modo touchpad/teclado remoto (opcional)
- [ ] Tela de touchpad (mover cursor, clique, rolagem) e teclado de texto
- [ ] Ligado/desligado nas configurações por segurança

## Futuro
- Linux (MPRIS), macOS, cliente iOS testado, app nativo, múltiplos notebooks.
