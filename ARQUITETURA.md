# Arquitetura — PC Media Control

## Visão geral
```
[Celular: PWA] <--WebSocket/HTTP na LAN--> [Host no notebook] --> [Windows: mídia + volume]
                                                    ^
                                      (fase futura) |
                                         [Extensão Chrome]
```

## Decisões iniciais (podem ser revistas via spike, registrando)
1. **Cliente = PWA servido pelo próprio host.** O celular abre uma URL local e instala na tela inicial. Funciona em Android e iOS sem loja, e evita desenvolver dois apps. App nativo fica como opção futura.
2. **Host em Python** (FastAPI + uvicorn + WebSocket). Roda como app de bandeja (tray) no Windows.
3. **Wi-Fi na mesma rede, sem servidor externo.** Bluetooth fica fora do MVP: pareamento e transporte são bem mais trabalhosos, variam por plataforma e não trazem ganho quando já há Wi-Fi.
4. **Descoberta:** mDNS/DNS-SD com `zeroconf`, publicando `_pcmedia._tcp.local.`. Como o PWA no navegador não consegue fazer mDNS por conta própria, o caminho prático é: o host mostra um **QR code** com a URL (`http://<ip>:<porta>/?pair=<token>`), e opcionalmente um nome `.local`. O QR também resolve o pareamento inicial.
5. **Pareamento:** QR com token de uso único (ou PIN de 6 dígitos como alternativa). Após parear, o cliente guarda um token de longa duração; o host mantém lista de dispositivos autorizados, com opção de revogar. Comandos de dispositivos não pareados são rejeitados.
6. **Camada de plataforma abstrata:** interface `PlatformAdapter` com implementação `WindowsAdapter` agora e espaço para `LinuxAdapter` (MPRIS) e `MacAdapter` depois.

## Windows: como ler e controlar mídia
- **Sessões de mídia:** GSMTC (Global System Media Transport Controls), via pacote Python `winsdk`/`winrt`. Dá título, artista, app de origem, estado, posição e comandos (play, pause, next, previous, seek).
- **Volume geral e por app:** Windows Core Audio via `pycaw` (volume mestre e `ISimpleAudioVolume` por sessão de áudio).
- **Fallback:** envio de teclas de mídia (play/pause, volume) quando um app não expuser sessão.

## Protocolo (WebSocket, JSON)
Servidor -> cliente:
- `state`: lista de sessões `{id, app, title, artist, status, position, duration, volume?}`, sessão ativa, volume geral
- `devices`/`error` quando aplicável

Cliente -> servidor:
- `command`: `{sessionId, action: play|pause|toggle|next|previous|seek, value?}`
- `volume`: `{target: master|sessionId, value: 0..1}`
- `select`: escolher sessão ativa

Versionar o protocolo (`"v": 1`) desde o início.

## Hipóteses a validar (Fase 0 — spike)
Nada abaixo deve ser assumido como verdadeiro. Verificar na prática e registrar o resultado aqui.
- [x] O GSMTC lista **uma sessão por aba** do Chrome ou apenas uma sessão agregada do Chrome? (isso define o "controle individual por aba")
  - **Resultado (parcial/confirmado para perfil padrão):** No `chrome.exe` padrão em execução (`pid=10812`), o GSMTC listou **duas sessões simultâneas e distintas** para abas de mídia diferentes (`web.whatsapp.com` + `TikTok - Make Your Day`; e depois `web.whatsapp.com` + vídeo `Tirú TV` com título, artista e duração próprios). **Ressalvas:** instâncias separadas abertas via `--user-data-dir` (sem atalho/AUMID registrado no Windows) não apareceram no GSMTC mesmo tocando áudio; além disso, comandos diretos (`pause`/`seek`) especificamente em 2 abas de YouTube simultâneas não foram exercitados automaticamente (pendente teste interativo com o navegador do usuário).
- [x] Dá para ler posição/duração e fazer seek de forma confiável no YouTube/Chrome, VLC e Spotify?
  - **Resultado (Spotify sim; Chrome parcial; VLC NÃO):**
    - **Spotify (`Spotify.exe`):** Leitura confiável de título, artista, álbum, posição e duração; `play`, `pause`, `toggle`, `next`, `previous` e `seek` (`try_change_playback_position_async` em ticks de 100 ns) funcionaram com retorno `True` e mudança real de estado/posição.
    - **Chrome / YouTube (`chrome.exe`):** Lê título, artista, duração (`125.78s`) e indica controles habilitados (`pause`, `toggle`, `seek`, sem `next`/`prev`), porém `timeline.position` permaneceu congelado no timestamp da última mudança (`0.01s` com `last_updated_time`), exigindo extrapolação no host via `position + (now_utc - last_updated_time)` quando `PLAYING`. O `seek` direto no YouTube ainda não foi exercitado manualmente.
    - **VLC (`vlc.exe` 3.0.23):** **Hipótese FALSA via GSMTC.** Mesmo reproduzindo áudio ativamente no Core Audio (`estado=Active`), o VLC 3.0.23 não possui plugin SMTC nativo (`plugins\control\`) e **não aparece no GSMTC**.
- [x] O volume por app consegue distinguir abas do Chrome? (provável que não: o Chrome agrupa áudio por processo. Se não der, controlar volume por app e não por aba.)
  - **Resultado (confirmado — não distingue abas):** Mesmo com 2 sessões GSMTC ativas no Chrome, o Windows Core Audio (`pycaw`) expôs **apenas 1 sessão de áudio** para toda a instância do `chrome.exe` (`GroupingParam` único). O controle de volume funciona de forma confiável para o **volume mestre** (inclusive mudo) e **por aplicativo** (`Spotify.exe`, `vlc.exe`, `chrome.exe`).
- [ ] mDNS é resolvido pelo Chrome do Android na rede do usuário? Se não, QR com IP é o caminho principal.
  - **Resultado parcial (pendente teste no Android):** No Windows, `zeroconf` publicou e descobriu `_pcmedia._tcp.local.` no IP da Wi-Fi (`172.16.230.140`) e `socket.getaddrinfo("w10-rp11.local", ...)` resolveu os IPs locais (incluindo o adaptador virtual Hyper-V `172.22.96.1`). Não havia aparelho Android conectado nesta execução para testar a resolução `.local` no Chrome do Android na rede `LADICA 2` (`172.16.230.140/16`). Por segurança, **QR code com IP direto continua como caminho principal**.
- [x] O firewall do Windows bloqueia a porta na primeira execução? Definir como orientar o usuário (regra para rede privada).
  - **Resultado (confirmado — bloqueia):** A rede Wi-Fi ativa (`LADICA 2`) está classificada como **Perfil Público** (`NetworkCategory = 0`), cuja política padrão do Windows Defender Firewall é **`BlockInbound,AllowOutbound`** com notificação ao usuário habilitada (`InboundUserNotification = Habilitar`). As regras existentes de entrada para `python.exe` cobrem apenas o Python global (`AppData\Local\Programs\Python\Python313\python.exe`), não o `.venv\Scripts\python.exe` nem um futuro executável. Na primeira execução na LAN, o usuário precisará mudar a Wi-Fi para **Rede Privada** e permitir o acesso no prompt do firewall (ou criar regra de entrada na porta do host para perfil Privado).

## Fase futura: extensão do Chrome
Pular anúncio, abrir busca/vídeo novo e controle fino por aba exigem acesso ao navegador. Plano: extensão Manifest V3 que conversa com o host por WebSocket em `localhost`, e o host repassa ao celular. Isso também pode substituir o GSMTC para o Chrome se o controle por aba for melhor por lá.

## Riscos e cuidados
- Segurança na LAN: sem pareamento, qualquer dispositivo na rede controlaria o PC. Pareamento é obrigatório desde a Fase 3; antes disso, o host escuta só em `127.0.0.1`.
- Não expor o host fora da rede local. Sem port-forward, sem túnel.
- Wi-Fi com isolamento de clientes (AP isolation) impede a conexão; documentar como diagnosticar.

## Decisões
- **2026-11-11 (Fase 0) — Trocar `winsdk` pelos pacotes modulares `winrt-*`:** `winsdk` não possui distribuição compatível no PyPI para Python 3.13.1; `winrt-Windows.Media.Control`, `winrt-Windows.Media`, `winrt-Windows.Foundation` e `winrt-Windows.Foundation.Collections` (`4!10.0.28000.2957`) instalam e operam normalmente.
- **2026-11-11 (Fase 0) — Identificação e timeline GSMTC no `WindowsAdapter`:** `GlobalSystemMediaTransportControlsSession` no `winrt-runtime` 4.x retorna novos objetos wrapper a cada chamada (`session == current_session` é `False`), exigindo comparação por assinatura/propriedades para identificar a sessão ativa; além disso, o Chrome congela `timeline.position` no instante do evento, tornando obrigatória a extrapolação por `last_updated_time` quando `PLAYING`.
- **2026-11-11 (Fase 0) — Seleção de IP da LAN deve ignorar adaptadores virtuais:** `ifaddr` retornou `Hyper-V Virtual Ethernet Adapter (172.22.96.1)` antes do Wi-Fi (`172.16.230.140`); na Fase 3, QR code e mDNS devem priorizar o IP da rota padrão / adaptador físico.
- **2026-11-11 (Fase 0) — Relatório de viabilidade e impacto no plano:**
  - *O que funciona:* GSMTC completo no Spotify (metadados, posição, play/pause/toggle/next/prev/seek); Chrome padrão expõe sessões GSMTC individuais por aba de mídia; `pycaw` (`20260927`) lê e altera volume mestre, mudo e volume por processo (`Spotify.exe`, `vlc.exe`, `chrome.exe`); `zeroconf` publica/resolve `_pcmedia._tcp.local.` localmente no Windows.
  - *O que não funciona / limitações:* VLC 3.0.23 **não** expõe sessão no GSMTC (apenas aparece no Core Audio para volume); Core Audio agrupa todas as abas do Chrome em uma única sessão de áudio; instâncias isoladas do Chrome via `--user-data-dir` não registram GSMTC; resolução mDNS no Chrome do Android ainda não foi testada; Wi-Fi em perfil Público bloqueia entrada no firewall por padrão.
  - *Impacto no plano (aguardando decisão do usuário):* (1) Volume fica definitivamente **por aplicativo** (não por aba). (2) Para **VLC 3.x**, escolher entre manter apenas o fallback de teclas de mídia (sem título/seek), integrar via interface HTTP/RC nativa do VLC ou exigir plugin `vlc-win10smtc`. (3) QR code com IP segue como descoberta primária até validar mDNS no Android na Fase 3. (4) Na Fase 1/3, documentar e orientar troca da rede Wi-Fi para Privada + permissão no firewall.
