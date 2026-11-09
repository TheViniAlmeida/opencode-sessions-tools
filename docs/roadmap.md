# Roadmap

## Entrega atual: especificação e plano

Decisões de produto, pesquisa, spec com critérios testáveis, revisão independente,
arquitetura e plano de execução. Não é release de software.

## Núcleo 1.0

Ferramentas para agentes e API local. Gestão de sessões, grupos, mensagens,
permissões, tarefas, agendamentos, compartilhamento de contexto, eventos e uso.
Uma instância OpenCode com vários projetos. Compatibilidade certificada por versão.

## Etapa posterior: dashboards TUI e web

Planejar as duas interfaces na mesma frente de produto após estabilizar o núcleo.
As interfaces usam a API pública, sem acesso direto ao banco do plugin.

Escopo solicitado para essa etapa:

- Visão geral de sessões, árvore, vínculos e grupos/sistemas.
- Estados, datas, atividade, modelos e agentes.
- Custos, tokens, orçamento e qualidade dos dados de consumo.
- Mensagens, perguntas, confirmações e tarefas.
- Contexto e memória compartilhada com revisões.
- Cron/timers, próximo disparo, histórico e erros.
- Ações de gestão com preview de impacto e autorização equivalente à API.

TUI e web terão specs próprias de navegação, acessibilidade, distribuição e
autenticação. Nenhuma dessas telas é requisito para declarar o núcleo 1.0 pronto.

## Depois, sem compromisso de release

Federação multi-host, migração entre instâncias e integrações externas de memória.
Esses itens não podem entrar implicitamente como dependências do núcleo.
