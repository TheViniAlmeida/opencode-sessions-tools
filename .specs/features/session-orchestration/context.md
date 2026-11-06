# Contexto e decisões

## Pedido

Gerenciar sessões e subsessões, trocar mensagens e resultados, formar grupos/sistemas,
controlar modelo/agente/permissões, agendar atividades, compartilhar contexto,
acompanhar eventos e consumo. Disponibilizar API local e documentação comunitária.

## Decisões confirmadas em 06/11/2026

1. Primeira versão: uma instância OpenCode, vários projetos.
2. Dashboard TUI e dashboard web serão posteriores, juntos em uma frente própria.
3. Uso profissional, reutilização, melhorias e contribuições permitidos; venda do
   plugin por terceiros proibida, conforme a política de licença.
4. Acesso adicional a outras sessões deve ser concedido por comando explícito.
5. Escrever documentos, criar spec, revisar/corrigir até aprovação técnica e só
   então produzir plano com fases. Implementação depende de etapa posterior.
6. Paralelizar sempre que dependências e propriedade de arquivos permitirem.

## Interpretações propostas, não falas do operador

- O comentário sobre comando explícito mantém a proposta citada: comunicação mínima
  dentro do projeto; concessão explícita para outros projetos e para poderes de
  leitura/gestão. Não equivale a liberar todo histórico ou administração no projeto.
- Criar filha não autoriza herança irrestrita. A chamada explicita o conjunto de
  capacidades delegadas, limitado ao que a origem pode delegar.
- Comandos humanos textuais são parte do núcleo; não são dashboard TUI.
- A política de licença exclui SaaS pago do plugin, mas as definições jurídicas e
  suporte pago ficam para aprovação do texto antes de distribuir código.

## Fontes

Pesquisa pública em [research.md](../../../docs/research.md). As duas referências
locais fornecidas pelo operador sobre Claude e Codex são descrições de capacidades,
não prova da API OpenCode. Delas derivam: correlação de pedidos, resultados
explícitos, diferença entre notificação e prompt e acompanhamento de filhos.

## Limite desta entrega

Revisão técnica dos documentos não valida software, isolamento do host ou licença.
O plano define provas e gates para que a implementação possa demonstrá-los.
