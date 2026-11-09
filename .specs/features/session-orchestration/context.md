# Contexto e decisões

## AD-010 — importação e anexo de contexto (08/11/2026)

Fonte: aprovação explícita do usuário, opção «Anexo de contexto (Recomendado)»,
relatada na solicitação desta atualização documental. Diante da questão sobre
whole import nativo versus append seguro, escolheu manter append na 1.0 como
conteúdo no storage plugin associado à sessão, acessível por ferramenta explícita,
SEM reescrever histórico nativo e SEM execução host. Create é importação nativa
de lote completo em nova sessão. Decisão de produto, não prova do host: adapter
nativo exportado parcial, batches pendentes, sem certificação native-full.
T27 REABERTA para integração e provas. AD-010 é o próximo ID livre após AD-009
no registro consultado; CTX-02 mantém ID, 85 históricos/82 ativos preservados.
Não muda licença, AD-007 ou boundary RPC/auth e não interfere no hardening
separado do registry de operador.

## Ordem atual — divisão T3 e início de T9 (07/11/2026)

Operador: «Aplique o ajuste no plano e inicie a T9». Revisor aprovou viabilidade
P0 no lote `rev-p0-fechamento`, 45 contract / 401 assertions (evidência recebida,
sem reexecução documental). T3 é o identificador preservado do gate T3-P0;
T9 depende dele e T4–T8, e foi iniciada pelo worker de código paralelo.
T3-PROD é subgate normativo pendente, depende T9–T13 e bloqueia T31/T32/T33 e
qualquer emissão de segredo. Mantém humano versus agente, always, auth/hardening
e revisão de armazenamento/provisionamento obrigatórios. Nenhum segredo real
autorizado. São 36 tarefas principais e um subgate, não T37; 82 edges Tn + oito
do subgate = 90, sem ciclo. AD-007 e 85 IDs históricos/82 ativos preservados.
Notas anteriores de bloqueio de P0/T9 abaixo são históricas e superadas apenas
por esta ordem e aprovação de viabilidade, não por um aceite de produto.

Estado vigente de 07/11/2026: AD-007 APROVADA; docs AD-008/009 APROVADAS na
rodada posterior. Preferência: gateway no setup/mesmo processo, callback lexical
privado não RPC/tool; separado assinado somente alternativa.
[Evidência](../../../docs/compatibility/identity.md): contexto de tool e unload
isolado/cleanup comprovados na fixture host 2.2.5, não identidade de operador;
mock não prova segurança de produto. Humano/always/auth/provisionamento permanecem
pendentes em T3-PROD. T9 liberada por ordem explícita após viabilidade P0 aprovada;
DAG ajustado separa subgate de produto. Correções dessa divisão aguardam re-review,
não as aprovações documentais históricas AD-008/009.

## Decisões confirmadas em 07/11/2026 — AD-008/009

- AD-008: scheduler próprio garante grant/revisão e lease na admissão LOCAL
  serializada do plugin; não promete revogação/fencing atômicos no host.
  unknown_outcome não permite retry cego. SCH-05/06 mantêm IDs e obrigações locais.
- AD-009: projetar credencial própria de operador da API separada de sessões.
  Validar canal em T3 e revisar armazenamento/provisionamento ANTES de criar
  segredo; emissão somente em provisionamento humano posterior. Não levar segredo
  a config visível ao modelo, tools/RPC, transcript ou contexto de agente.
- Estas autorizações não fecham P0, não retiram API da 1.0 e não alteram AD-007.
  Contagem preservada: 85 IDs históricos, 82 ativos, três deferred.

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

## Atualização autorizada — 07/11/2026

A autorização posterior para implementar supera o limite documental de AD-005,
sem apagar o pedido histórico de 06/11/2026. AD-007 retira exclusão destrutiva de
sessões da 1.0 e mantém archive/restore. Não haverá ferramenta, comando ou API
delete-preview/delete-confirm; o produto não chama DELETE. LIF-08/09/10 permanecem
IDs históricos deferred: 85 IDs preservados, 82 critérios ativos de aceite.
T18 passa a tratar exclusão externa, tombstones, bloqueio de pendências e limpeza
somente do storage próprio (REL-03/04); retenção local não exclui sessões do host.
A [prova T5](../../../docs/compatibility/lifecycle.md) é evidência histórica,
não reescrita por essa decisão; DELETE no probe continua restrito ao ambiente
sintético expressamente autorizado. Revisão independente desta mudança: APROVADA.

## Limite desta entrega

Revisão técnica dos documentos não valida software, isolamento do host ou licença.
O plano define provas e gates para que a implementação possa demonstrá-los.
