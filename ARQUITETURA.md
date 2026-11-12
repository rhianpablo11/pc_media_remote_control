# Arquitetura — PC Media Control

## Visão geral
```
[Celular: PWA] <--WebSocket/HTTP na LAN--> [Host no notebook (.venv Windows)]
                                              |-- WindowsProvider --> [GSMTC + Pycaw + Media Keys]
                                              |-- ChromeExtensionProvider <--WS localhost-- [Extensão Chrome MV3]
```

## Decisões iniciais e arquitetura do host
1. **Cliente = PWA servido pelo próprio host.** O celular abre uma URL local e instala na tela inicial. Funciona em Android e iOS sem loja, e evita desenvolver dois apps. App nativo fica como opção futura.
2. **Host em Python** (FastAPI + uvicorn + WebSocket), rodando nativamente no Windows via `.venv` (sem WSL) e empacotado como app de bandeja (tray) na Fase 5.
3. **Wi-Fi na mesma rede, sem servidor externo.** Bluetooth fica fora do MVP: pareamento e transporte são bem mais trabalhosos, variam por plataforma e não trazem ganho quando já há Wi-Fi.
4. **Descoberta:** mDNS/DNS-SD com `zeroconf`, publicando `_pcmedia._tcp.local.`. Como o PWA no navegador não consegue fazer mDNS por conta própria, o caminho prático é: o host mostra um **QR code** com a URL (`http://<ip>:<porta>/?pair=<token>`), filtrando adaptadores virtuais (Hyper-V/WSL) ao escolher o IP da LAN, e opcionalmente um nome `.local`. O QR também resolve o pareamento inicial.
5. **Pareamento:** QR com token de uso único (ou PIN de 6 dígitos como alternativa). Após parear, o cliente guarda um token de longa duração; o host mantém lista de dispositivos autorizados, com opção de revogar. Comandos de dispositivos não pareados são rejeitados.
6. **Provedores de sessão no host (`SessionProvider` / `PlatformAdapter`):**
   - O host mantém uma abstração de provedores de sessão e unifica todas as sessões em uma única lista, com `id` incluindo a origem (ex.: `windows:...`, `chrome:...`).
   - `WindowsProvider` (específico do Windows; espaço arquitetural preservado para `LinuxProvider`/`MacProvider` depois): lê e controla apps nativos (Spotify etc.) via GSMTC (`winrt-*`), lê e altera volume mestre/por app via Core Audio (`pycaw`) e oferece fallback via teclas de mídia globais (ex.: VLC 3.x).
   - `ChromeExtensionProvider`: recebe sessões e encaminha comandos/volume por aba vindos da extensão Chrome MV3 conectada em `localhost`.
   - **Deduplicação:** enquanto a extensão Chrome estiver conectada ao host, o host oculta as sessões GSMTC vindas de `chrome.exe` para evitar duplicatas.

## Windows: como ler e controlar mídia
- **Sessões de mídia:** GSMTC (Global System Media Transport Controls), via pacotes modulares `winrt-Windows.Media.Control` (e complementos `winrt-*`). Dá título, artista, app de origem, estado, posição e comandos (play, pause, next, previous, seek) para Spotify e apps compatíveis.
- **Volume geral e por app:** Windows Core Audio via `pycaw` (volume mestre e `ISimpleAudioVolume` por processo).
- **Fallback:** envio de teclas de mídia (play/pause, próximo, anterior, volume) quando um app não expuser sessão GSMTC (caso do VLC 3.x).

## Extensão do Chrome (MV3 — Fase 2)
- Arquitetura Manifest V3 com **content script** (acesso direto ao `<video>` e `navigator.mediaSession` na página) + **service worker** (gerenciamento de abas e conexão WebSocket em `localhost` com o host).
- Responsável por listar múltiplas abas de mídia (ex.: 2+ abas do YouTube) com título/canal/miniatura, controlar play/pause/seek por aba, ajustar **volume por aba** (via `video.volume` no content script e/ou silenciar aba no navegador), pular anúncios do YouTube quando o botão existir e abrir buscas/URLs a partir do celular.

## Protocolo (WebSocket, JSON)
Servidor -> cliente:
- `state`: lista unificada de sessões `{id, source, app, title, artist, status, position, duration, controls, volume?, muted?}` (com `id` incluindo a origem), sessão ativa, volume mestre e sessões de áudio por app (`audioSessions`)
- `devices`/`error` quando aplicável

Cliente -> servidor:
- `command`: `{sessionId, action: play|pause|toggle|next|previous|seek, value?}`
- `volume`: `{target: master|sessionId|appId, value?: 0..1, muted?: bool}`
- `select`: `{sessionId}` escolher sessão ativa

Versionar o protocolo (`"v": 1`) desde o início.

## Hipóteses a validar (Fase 0 — spike)
Nada abaixo deve ser assumido como verdadeiro. Verificar na prática e registrar o resultado aqui.
- [x] ~~O GSMTC lista **uma sessão por aba** do Chrome ou apenas uma sessão agregada do Chrome?~~ **[REFUTADA para múltiplas abas do YouTube]**
  - **Resultado (REFUTADA pelo teste do usuário):** Com **duas abas do YouTube tocando simultaneamente no Chrome normal**, o GSMTC listou apenas **uma** sessão, e o `spike_media.py` só controlava essa sessão única — apesar de o painel nativo de mídia do Chrome listar as duas abas. (Em testes anteriores com sites diferentes como WhatsApp Web + TikTok chegaram a aparecer duas entradas pontuais, mas para o cenário real de múltiplas abas do YouTube o GSMTC não entrega controle por aba.) **Impacto:** o controle individual por aba do Chrome passa a ser feito pela extensão MV3 (`ChromeExtensionProvider`).
- [x] Dá para ler posição/duração e fazer seek de forma confiável no YouTube/Chrome, VLC e Spotify?
  - **Resultado (Spotify sim; Chrome/YouTube limitado no GSMTC; VLC NÃO):**
    - **Spotify (`Spotify.exe`):** Leitura confiável de título, artista, álbum, posição e duração; `play`, `pause`, `toggle`, `next`, `previous` e `seek` (`try_change_playback_position_async` em ticks de 100 ns) funcionaram com retorno `True` e mudança real de estado/posição.
    - **Chrome / YouTube (`chrome.exe`):** Lê título, artista, duração e controles (`pause`, `toggle`, `seek`, sem `next`/`prev`), porém `timeline.position` permanece congelado no timestamp do último evento (`last_updated_time`), exigindo extrapolação por tempo decorrido quando `PLAYING`, e não separa múltiplas abas de YouTube no GSMTC — movido para a extensão na Fase 2.
    - **VLC (`vlc.exe` 3.0.23):** **Hipótese FALSA via GSMTC.** Mesmo reproduzindo áudio ativamente no Core Audio (`estado=Active`), o VLC 3.0.23 não possui plugin SMTC nativo (`plugins\control\`) e **não aparece no GSMTC**. Mantido no fallback de teclas de mídia + volume por processo no `pycaw`.
- [x] O volume por app consegue distinguir abas do Chrome? (provável que não: o Chrome agrupa áudio por processo. Se não der, controlar volume por app e não por aba.)
  - **Resultado (confirmado — não distingue abas):** O Windows Core Audio (`pycaw`) expõe **apenas 1 sessão de áudio** para todo o processo `chrome.exe` (`GroupingParam` único). O volume geral e por aplicativo (`Spotify.exe`, `vlc.exe`, `chrome.exe`) funciona via `pycaw`; já o **volume por aba no Chrome** será implementado na extensão MV3 (propriedade `volume` do elemento `<video>` e/ou silenciamento da aba).
- [ ] mDNS é resolvido pelo Chrome do Android na rede do usuário? Se não, QR com IP é o caminho principal.
  - **Resultado parcial (pendente teste no Android na Fase 4):** No Windows, `zeroconf` publicou e descobriu `_pcmedia._tcp.local.` no IP da Wi-Fi (`172.16.230.140`) e `socket.getaddrinfo("w10-rp11.local", ...)` resolveu os IPs locais (incluindo o adaptador virtual Hyper-V `172.22.96.1`). Não havia aparelho Android conectado nesta etapa para testar `.local` no Chrome do Android. **QR code com IP direto continua como caminho principal**, filtrando adaptadores virtuais (Hyper-V/WSL).
- [x] O firewall do Windows bloqueia a porta na primeira execução? Definir como orientar o usuário (regra para rede privada).
  - **Resultado (confirmado — bloqueia):** A rede Wi-Fi ativa (`LADICA 2`) está como **Perfil Público** (`NetworkCategory = 0`), com política **`BlockInbound,AllowOutbound`** e `InboundUserNotification = Habilitar`. As regras de entrada existentes para `python.exe` cobrem apenas o Python global (`AppData\Local\Programs\Python\Python313\python.exe`), não o `.venv\Scripts\python.exe` nem um futuro executável. Na Fase 4, orientar o usuário a mudar a Wi-Fi para **Rede Privada** ou criar regra de firewall para o executável/porta.

## Riscos e cuidados
- Segurança na LAN: sem pareamento, qualquer dispositivo na rede controlaria o PC. Pareamento é obrigatório a partir da Fase 4 (exposição na LAN); antes disso, o host escuta só em `127.0.0.1`.
- Não expor o host fora da rede local. Sem port-forward, sem túnel.
- Adaptadores virtuais (Hyper-V/WSL/VPN) não devem ser escolhidos como IP da LAN no QR code ou no mDNS.
- Wi-Fi configurada como **Perfil Público** bloqueia conexões de entrada no Firewall do Windows; orientar mudança para **Perfil Privado** ou criação de regra para o executável/porta.
- Wi-Fi com isolamento de clientes (AP isolation, comum em redes universitárias/públicas como `172.16.x.x`) impede comunicação entre celular e notebook; documentar diagnóstico e **plano B via hotspot** (roteador Wi-Fi do notebook ou do celular).

## Decisões
- **2026-11-11 (Fase 0) — Trocar `winsdk` pelos pacotes modulares `winrt-*`:** `winsdk` não possui distribuição compatível no PyPI para Python 3.13.1; `winrt-Windows.Media.Control`, `winrt-Windows.Media`, `winrt-Windows.Foundation` e `winrt-Windows.Foundation.Collections` (`4!10.0.28000.2957`) instalam e operam normalmente.
- **2026-11-11 (Fase 0) — Identificação e timeline GSMTC no `WindowsProvider`:** `GlobalSystemMediaTransportControlsSession` no `winrt-runtime` 4.x retorna novos objetos wrapper a cada chamada (`session == current_session` é `False`), exigindo comparação por assinatura/propriedades para identificar a sessão ativa; além disso, é necessária extrapolação por `last_updated_time` quando `PLAYING`.
- **2026-11-11 (Fase 0) — Seleção de IP da LAN deve ignorar adaptadores virtuais:** `ifaddr` retornou `Hyper-V Virtual Ethernet Adapter (172.22.96.1)` antes do Wi-Fi (`172.16.230.140`); na fase de rede/pareamento, QR code e mDNS devem filtrar adaptadores virtuais (Hyper-V/WSL) e priorizar a interface física da rota padrão.
- **2026-11-11 (Pós-Fase 0) — Hipótese de GSMTC por aba REFUTADA para múltiplas abas do YouTube:** Teste prático com 2 abas do YouTube no Chrome normal exibiu apenas 1 sessão no GSMTC (enquanto o painel nativo do Chrome lista as 2); o controle por aba do Chrome passa para uma extensão MV3 (`content script` + `service worker`, WebSocket em `localhost`).
- **2026-11-11 (Pós-Fase 0) — Volume por aba do Chrome via extensão:** Como o Core Audio agrupa todo o `chrome.exe` numa única sessão de áudio, o volume por aba será feito pela extensão (propriedade `volume` do `<video>` e/ou silenciar a aba), mantendo o `pycaw` para volume mestre e por processo.
- **2026-11-11 (Pós-Fase 0) — Abstração de provedores de sessão no host:** O host adota `SessionProvider` com `WindowsProvider` (GSMTC + Core Audio + fallback de teclas de mídia) e `ChromeExtensionProvider`, unificando sessões numa lista com `id` prefixado pela origem e ocultando sessões GSMTC de `chrome.exe` enquanto a extensão estiver conectada.
- **2026-11-11 (Pós-Fase 0) — VLC 3.x fica no fallback de teclas de mídia:** Como o VLC 3.0.23 não expõe sessão GSMTC, permanece no fallback global de teclas de mídia (sem leitura de título/seek) e com controle de volume por processo via `pycaw`.
- **2026-11-11 (Pós-Fase 0) — Ambiente nativo Windows (`.venv`) e reordenação de fases:** Projeto roda diretamente no Windows com `.venv` (sem WSL; adapter/provedor específico do Windows), e a extensão Chrome é antecipada para a Fase 2 (antes do PWA) para consolidar o controle multi-aba na base do sistema.
- **2026-11-11 (Fase 1) — Servidor `host/` em FastAPI + endpoints WS locais:** Servidor `host` (`127.0.0.1:8765`) expõe `/` (página mínima de teste), `/health`, `/api/state`, `/ws` (clientes de controle, Protocolo v1 validado com Pydantic) e `/ws/extension` (restrito a `localhost` para a extensão Chrome), com coleta de estado serializada por `asyncio.Lock` e loop de atualização ativo apenas quando há clientes conectados.
- **2026-11-11 (Fase 1) — Executor COM dedicado para Core Audio (`pycaw`):** No `WindowsProvider`, chamadas `pycaw` rodam em `ThreadPoolExecutor` de thread única inicializada com `comtypes.CoInitialize()`, evitando falhas de apartamento COM entre threads do pool padrão do `asyncio`.
