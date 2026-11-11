# Visão — PC Media Control

## Problema
Notebook ligado no monitor, usuário deitado na cama assistindo YouTube. O vídeo pausa, aparece anúncio ou é preciso trocar de vídeo, e é necessário levantar para mexer no teclado/mouse.

## Objetivo
Usar o notebook como central de mídia: ele reproduz, e o celular só controla. A mídia pode estar no Chrome (YouTube etc.), VLC, Spotify ou qualquer app que exponha controles de mídia ao sistema. Deve ser possível controlar também o volume, geral e por aplicativo.

## Cenário de uso (critério de sucesso do MVP)
1. Abro o app/página no celular, na mesma rede Wi-Fi do notebook.
2. Vejo o que está tocando (título, artista/canal, app de origem, progresso).
3. Dou play/pause, avanço, volto, próximo/anterior e ajusto o volume, sem encostar no notebook.
4. Se houver várias mídias (ex.: duas abas do Chrome), consigo escolher qual controlar.

## Plataformas
- **Host (notebook):** Windows primeiro. Arquitetura preparada para Linux e macOS depois.
- **Cliente (celular):** Android primeiro, com caminho aberto para iOS.

## Conexão
- Mesma rede Wi-Fi, sem servidor externo intermediando.
- Descoberta automática (sem digitar IP/porta).
- Pareamento na primeira vez, porque pode haver outros dispositivos na rede.

## Fora do escopo do MVP
- Pular anúncio do YouTube e buscar/abrir vídeo novo (exigem integração com o navegador; entram na fase da extensão).
- Controle remoto fora da rede local.
- Bluetooth (ver justificativa em `ARQUITETURA.md`).
- App nativo de loja.

## Conteúdo original do usuário (referência)
- No Google Chrome existe um controle nativo dos conteúdos em reprodução (pausar, avançar, retroceder), por aba. O projeto deve permitir controlar cada conteúdo individualmente.
- Volume individual por app e geral do computador.
