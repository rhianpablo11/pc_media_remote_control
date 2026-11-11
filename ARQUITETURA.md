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
- [ ] O GSMTC lista **uma sessão por aba** do Chrome ou apenas uma sessão agregada do Chrome? (isso define o "controle individual por aba")
- [ ] Dá para ler posição/duração e fazer seek de forma confiável no YouTube/Chrome, VLC e Spotify?
- [ ] O volume por app consegue distinguir abas do Chrome? (provável que não: o Chrome agrupa áudio por processo. Se não der, controlar volume por app e não por aba.)
- [ ] mDNS é resolvido pelo Chrome do Android na rede do usuário? Se não, QR com IP é o caminho principal.
- [ ] O firewall do Windows bloqueia a porta na primeira execução? Definir como orientar o usuário (regra para rede privada).

## Fase futura: extensão do Chrome
Pular anúncio, abrir busca/vídeo novo e controle fino por aba exigem acesso ao navegador. Plano: extensão Manifest V3 que conversa com o host por WebSocket em `localhost`, e o host repassa ao celular. Isso também pode substituir o GSMTC para o Chrome se o controle por aba for melhor por lá.

## Riscos e cuidados
- Segurança na LAN: sem pareamento, qualquer dispositivo na rede controlaria o PC. Pareamento é obrigatório desde a Fase 3; antes disso, o host escuta só em `127.0.0.1`.
- Não expor o host fora da rede local. Sem port-forward, sem túnel.
- Wi-Fi com isolamento de clientes (AP isolation) impede a conexão; documentar como diagnosticar.

## Decisões
(o agente registra aqui novas decisões, uma linha cada, com data e motivo)
