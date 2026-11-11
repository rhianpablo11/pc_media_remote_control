# Design — PC Media Control

## Direção
Simples, sofisticado e com cara de produto bem projetado. Inspiração: design da Apple (hierarquia clara, muito respiro, tipografia forte, movimento sutil). Sem enfeite desnecessário.

## Temas
- Claro, escuro e **automático** (segue `prefers-color-scheme`), com opção manual nas configurações.
- Tokens de cor via variáveis CSS (`--bg`, `--surface`, `--text`, `--text-secondary`, `--accent`, `--separator`), nunca cores soltas no código.
- Contraste mínimo AA em ambos os temas.

## Tipografia e forma
- Fonte do sistema: `-apple-system, "SF Pro", Inter, system-ui, sans-serif`.
- Títulos grandes e em peso semibold; texto secundário em cinza suave.
- Cantos arredondados generosos (cards ~20–28px), sombras suaves ou bordas finas no lugar de sombras pesadas.

## Tela principal: "Tocando agora"
- Card central com capa/ícone do app, título, artista/canal, app de origem.
- Barra de progresso arrastável com tempo atual e total.
- Controles grandes: anterior, play/pause (destaque), próximo. Alvos de toque de no mínimo 44px, em uso com uma mão.
- Slider de volume geral sempre acessível.
- Seletor de sessão (quando houver mais de uma mídia): lista compacta tipo "sheet" que sobe de baixo.

## Tela de volume
- Volume geral no topo; abaixo, uma linha por app com ícone, nome e slider.

## Estados obrigatórios
- Sem conexão / conectando / reconectando automático
- Nenhuma mídia tocando
- Não pareado (leva ao fluxo de pareamento com leitura de QR ou PIN)
- Erro de comando (feedback discreto, sem travar a tela)

## Comportamento
- Feedback tátil leve (`navigator.vibrate`) nos botões, quando suportado.
- Animações curtas (150–250ms) e respeitando `prefers-reduced-motion`.
- Respeitar safe areas (notch/barra de gestos).
- Ao abrir, mostrar o último estado conhecido imediatamente e atualizar em seguida.
- Instalável como PWA (manifest + ícones), orientação retrato.
