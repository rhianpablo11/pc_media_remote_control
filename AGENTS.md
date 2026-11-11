# AGENTS.md — PC Media Control

Este arquivo é a porta de entrada. Leia-o primeiro, sempre.

## O que é o projeto
Transformar o notebook (Windows) numa central de mídia controlada pelo celular, via rede local (mesmo Wi-Fi), sem servidor externo. Detalhes em `VISAO.md`.

## Ordem de leitura
1. `VISAO.md` — objetivo e escopo
2. `ARQUITETURA.md` — stack, componentes, protocolo, hipóteses a validar
3. `DESIGN.md` — padrão visual do cliente
4. `FASES.md` — plano de execução (é aqui que você acompanha o progresso)

## Regras de trabalho
- **Uma fase por vez.** Só trabalhe na fase marcada como atual em `FASES.md`.
- Ao concluir uma fase: rode os testes, marque os checkboxes em `FASES.md`, faça commit e **pare** para reportar o que foi feito, o que falhou e o que decidiu. Não avance sem eu dizer "pode seguir".
- Se uma hipótese listada em `ARQUITETURA.md` (seção "Hipóteses a validar") se mostrar falsa, **não contorne em silêncio**: registre o resultado em `ARQUITETURA.md` e me avise antes de mudar o plano.
- Decisões novas (biblioteca escolhida, mudança de protocolo, etc.) entram na seção "Decisões" de `ARQUITETURA.md` com uma linha de justificativa.
- Não adicione dependências pesadas sem necessidade. Prefira poucas e bem mantidas.
- Sem telemetria, sem serviços externos, sem contas. Tudo roda local.
- Segurança básica desde a fase 1: o host só aceita comandos de dispositivos pareados (ver `ARQUITETURA.md`).
- Se algo do pedido for ambíguo e mudar muito o resultado, pergunte. Se for detalhe pequeno, escolha o padrão mais simples e registre.

## Convenções
- Código, nomes e commits de código em inglês; documentação e mensagens de UI em português do Brasil.
- Commits pequenos, mensagem no formato `fase-N: o que mudou`.
- Python 3.12+, tipagem com type hints, `ruff` para lint, `pytest` para testes.
- Cliente: React + TypeScript + Tailwind (Vite).
- Estrutura de pastas sugerida (ajuste se tiver motivo, e registre):
  ```
  host/        # servidor Python (FastAPI)
  client/      # PWA React
  extension/   # extensão Chrome (fase posterior)
  scripts/     # utilitários e spikes
  ```
