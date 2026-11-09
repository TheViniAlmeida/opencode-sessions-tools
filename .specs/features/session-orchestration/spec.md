# Session orchestration specification

Status: AD-007 APROVADA; docs AD-008/009 APROVADAS na rodada posterior de 07/11/2026. Viabilidade P0 APROVADA no lote rev-p0-fechamento; T9 liberada por ordem explícita e em andamento. Auth/provisionamento de produto permanecem em T3-PROD e implementação nas tarefas respectivas, sem autorização de segredo. Correções documentais da divisão aguardam re-review, sem suspender início de T9. Escopo: núcleo 1.0, 82 critérios ativos e 3 IDs históricos deferred (85 IDs preservados).

## Problem Statement

Sessões não dispõem de uma interface uniforme para delegar trabalho, receber retorno,
administrar vínculos e recuperar coordenação após falhas. O plugin fornece essas
operações por ferramentas e API local sem depender de um dashboard.

## Goals

- Coordenar sessões de vários projetos em uma instância OpenCode.
- Produzir entrega e resultado rastreáveis, sem confundir admissão com conclusão.
- Aplicar concessões explícitas e revogáveis a leitura e gestão.
- Expor contratos estáveis, consumo, eventos e recuperação testáveis.

## Out of Scope

| Recurso | Motivo |
| --- | --- |
| Dashboard TUI e web | Entrega futura conjunta, decisão do operador |
| Exclusão destrutiva de sessões do host | AD-007, 07/11/2026; LIF-08/09/10 deferred, sem ferramentas, comandos ou API de exclusão na 1.0 |
| Federação entre servidores/hosts | Versão inicial usa uma instância |
| Compatibilidade V1 | Contratos V2 apenas |
| Sandbox de SO contra shell irrestrito | Permissões do plugin não isolam credenciais do host |
| Merge automático de código | Orquestração não aprova integração de alterações |
| Migração Claude/Codex integral | Referências conceituais, não formatos de importação obrigatórios |
| Memória vetorial ou serviço externo | Quadro compartilhado local suficiente para esta versão |

## Assumptions & Open Questions

| Assumption / decision | Chosen default | Rationale | Confirmed? |
| --- | --- | --- | --- |
| Comunicação no projeto | Descoberta mínima e mensagens, não histórico nem gestão | Preserva proposta aceita sem ampliação implícita | Interpretação a confirmar na aprovação |
| Grant adicional | Somente operador concede; agente pode solicitar | Evita autoconcessão entre sessões | Proposta |
| API de operador | Credencial própria, separada de sessões; canal e provisionamento revisados antes de emitir segredo | ID no payload e autenticação do transporte nativo não são identidade de operador | AD-009, 07/11/2026; prova técnica T3 pendente |
| Armazenamento | SQLite próprio por instância, nunca banco interno do host | Transações e recuperação | Proposta |
| Compatibilidade | Fixar baseline exata após testes com 2.2.5 | Docs publicadas podem divergir do binário | Proposta; gate P0 |
| Scheduler | Próprio; grant/revisão e lease garantidos na admissão local do plugin | Sem atomicidade de revogação/fencing no host; unknown_outcome sem retry cego | AD-008, 07/11/2026; provas e revisão pendentes |
| Limites iniciais | 64 KiB por mensagem, 10 MiB por pacote, 100 itens/página | Limites explícitos e testáveis | Proposta configurável pelo operador |
| Automação | 4 tarefas simultâneas por grupo; profundidade 4; 8 saltos automáticos | Evita explosão de chamadas | Proposta configurável pelo operador |
| Tempo e retenção | UTC armazenado; fuso IANA no job; auditoria 30 dias | Comparação consistente e armazenamento limitado | Proposta |
| Testes | Unitários, integração, contrato e e2e; comandos criados no bootstrap | Repositório sem testes ou manifests | Proposta para aprovação do plano |
| Licença | Política aprovada; texto jurídico fechado antes de publicar código | Não substituir licença por intenção | Gate de release |

Open questions: none — decisões não confirmadas estão explicitamente registradas acima;
nenhuma delas é descrita como aprovação humana. Provas P0 podem bloquear execução,
mas não autorizar redução silenciosa do escopo.

## Vocabulário e contratos comuns

- `principal`: operador autenticado ou sessão autenticada pelo contexto do host.
- `sessionRef`: identidade da instância + ID da sessão, com projeto resolvido no host.
- `grant`: origem, destino, capacidades, revisão, emissor, criação e expiração.
- `group`: coleção organizacional; não concede capacidades por associação.
- `task`: pedido de trabalho com estado e resultado próprios.
- `delivery`: registro da entrega ao host; não prova leitura pelo modelo.
- `capabilities`: discover, message, read, manage, session.configure, context.read, context.write,
  task.dispatch, schedule.manage; policy exige operador. Exclusão de sessões não é capability da 1.0.
- Erros de domínio: `invalid_input`, `not_found`, `forbidden`, `conflict`,
  `unsupported`, `expired`, `rate_limited`, `unavailable`, `unknown_outcome`.
- Toda mutação recebe chave idempotente obrigatória; chave escopada ao principal e
  operação, conteúdo normalizado com hash. Mesmo conteúdo devolve a operação original;
  conteúdo diferente devolve `conflict`. Chaves retidas por 30 dias; após isso uma
  repetição pode criar nova operação, explicitado na API.

Destinos de mensagens, tarefas e jobs são `sessionRef`, não grupo. Broadcast é
expansão explícita feita pelo chamador em operações individuais. Remover membro
do grupo não revoga grants; excluir grupo exige ausência de tarefas não terminais
e jobs ativos, senão `conflict`. Grupos não excluem sessões.

Orçamentos são configurados pelo operador por grupo, persistem entre reinícios e
limitam admissões de tarefas daquele grupo. Não somar grupos como se fossem
disjuntos. Se há teto mas consumo não é mensurável, bloquear admissão com
`unavailable`; não presumir saldo. Sem teto, ausência de custo não bloqueia uso.

Eventos mínimos: `grant.created`, `grant.revoked`, `message.admitted`,
`message.rejected`, `task.state_changed`, `request.resolved`, `session.changed`,
`job.state_changed`, `job.fired`, `context.changed`, `budget.changed`, `operation.unknown`.
Todos incluem sequência, ator, instante, alvo e operationID; alterações de grant
incluem capacidades e revisão. Conteúdo de prompts não entra nesse catálogo.

### Estados fechados e transições

| Entidade | Origem | Próximos estados permitidos |
| --- | --- | --- |
| Delivery | pending | dispatching, rejected, expired |
| Delivery | dispatching | admitted, rejected, unknown_outcome |
| Delivery | unknown_outcome | admitted, rejected (somente com reconciliação comprovada) |
| Delivery | admitted, rejected, expired | Nenhum; nova tentativa tem outra identidade |
| Task | pending | running, blocked, cancelled |
| Task | blocked | pending (replanejamento explícito), cancelled |
| Task | running | completed, failed, awaiting_input, awaiting_approval, cancel_requested |
| Task | awaiting_input, awaiting_approval | running, cancel_requested |
| Task | cancel_requested | cancelled, completed, failed |
| Task | completed, failed, cancelled | Nenhum; retry cria outra tentativa |

`already_admitted` é resultado de revogação/cancelamento, não estado. `delivered`
e `read` não são inferidos. `admitted` comprova aceite no host ou disponibilidade
na inbox do plugin, com `channel` distinguindo os dois.

## User Stories

### P1: Identificar e organizar sessões

User Story: como operador/agente, quero localizar sessões autorizadas e sua árvore.

Acceptance Criteria:

1. WHEN uma ferramenta chama `current` THEN o sistema SHALL obter a identidade do contexto autenticado do host, ignorando alegações de identidade no payload. [SES-01]
2. WHEN uma sessão lista o próprio projeto THEN o sistema SHALL retornar somente ID, título, estado e filiação autorizada, sem mensagens, prompts, caminhos de arquivos ou metadados arbitrários. [SES-02]
3. WHEN uma sessão consulta projeto sem vínculo THEN o sistema SHALL retornar `not_found`, sem revelar existência ou títulos. [SES-03]
4. WHEN uma listagem excede 100 registros THEN o sistema SHALL retornar até 100 itens e cursor opaco para a próxima página. [SES-04]
5. WHEN um grupo é criado ou alterado THEN o sistema SHALL persistir sua composição sem alterar grants das sessões. [SES-05]
6. WHEN uma árvore contém vínculos cíclicos THEN o sistema SHALL retornar cada sessão uma vez e representar vínculos separadamente da filiação. [SES-06]

Independent Test: três sessões, duas no projeto A e uma em B; listar A, negar B,
vincular B e verificar visibilidade sem abrir histórico.

### P1: Conceder e revogar acesso

Acceptance Criteria:

1. WHEN o operador executa `link` com origem, destino e capacidades THEN o sistema SHALL persistir grant direcional explícito com revisão e validade opcional. [ACL-01]
2. IF uma sessão tenta conceder ou ampliar grant THEN o sistema SHALL negar com `forbidden` e permitir apenas registrar uma solicitação ao operador. [ACL-02]
3. WHEN uma operação acessa outra sessão THEN o sistema SHALL verificar capacidades atuais, projeto canônico e política do host antes do efeito. [ACL-03]
4. WHEN `unlink` é confirmado THEN o sistema SHALL impedir novas admissões pelo grant revogado e marcar pendências ainda não admitidas como `rejected`. [ACL-04]
5. IF a entrega já foi admitida antes da revogação THEN o sistema SHALL informar `already_admitted` sem prometer retirar conteúdo do histórico. [ACL-05]
6. WHEN um agente altera permissões de execução THEN o sistema SHALL exigir autorização do operador e preservar denies obrigatórios do host. [ACL-06]
7. IF uma chamada RPC apresenta apenas um `sessionID` como prova de origem THEN o sistema SHALL recusá-la como principal de sessão não autenticado. [ACL-07]
8. WHEN uma sessão solicita grant THEN o sistema SHALL registrar pedido idempotente visível somente à origem e ao operador, sem conceder qualquer capacidade enquanto pendente. [ACL-08]
9. WHEN o operador resolve solicitação de acesso THEN o sistema SHALL registrar aprovada por link explícito ou negada, encerrando pedidos não resolvidos após 24 horas sem conceder acesso. [ACL-09]
10. WHEN uma política de delegação é restringida pelo operador THEN o sistema SHALL reavaliar admissões futuras de filhas existentes contra essa política vigente, sem prometer interromper efeitos já iniciados. [ACL-10]
11. IF agente tenta responder permissão com `always` ou alterar modelo/agente da própria sessão THEN o sistema SHALL exigir resolução do operador, sem usar texto do agente como aprovação. [ACL-11]

Independent Test: falsificar origem, conceder A→B sem B→A, revogar durante fila e
verificar a fronteira transacional da admissão.

### P1: Enviar e receber

Acceptance Criteria:

1. WHEN `send` recebe notificação válida THEN o sistema SHALL persistir envelope com origem, destino, tipo, correlação, validade e estado antes de tentar entregar. [MSG-01]
2. WHEN uma notificação é entregue THEN o sistema SHALL disponibilizá-la sem iniciar execução do modelo no destino. [MSG-02]
3. WHEN `request` admite trabalho THEN o sistema SHALL criar tarefa correlacionada e encaminhar prompt com política `queue` por padrão. [MSG-03]
4. WHEN `reply` aponta uma solicitação autorizada THEN o sistema SHALL registrar a resposta na conversa correlacionada e disponibilizar recibo ao remetente. [MSG-04]
5. IF chave idempotente é repetida com o mesmo envelope THEN o sistema SHALL retornar o mesmo ID sem nova entrega lógica. [MSG-05]
6. IF o host pode ter admitido a mensagem antes de um timeout THEN o sistema SHALL marcar `unknown_outcome` e reconciliar por identidade comprovável antes de repetir a admissão. [MSG-06]
7. WHEN uma sessão está ocupada THEN o sistema SHALL preservar FIFO de mensagens `queue` admitidas pelo plugin para aquele destino. [MSG-07]
8. WHEN uma cadeia automática tenta ultrapassar 8 saltos THEN o sistema SHALL bloquear o novo encaminhamento com `rate_limited` e registrar o motivo. [MSG-08]
9. IF conteúdo excede 64 KiB em UTF-8 THEN o sistema SHALL recusar com `invalid_input` antes da persistência do conteúdo. [MSG-09]
10. WHEN `wait` atinge o prazo máximo de 30 segundos THEN o sistema SHALL retornar estado pendente e cursor sem manter execução de modelo em polling. [MSG-10]

Independent Test: A solicita B, B responde, repetir chamadas, interromper conexão
após admissão e provar ausência de execução duplicada por retry cego.

### P1: Gerenciar ciclo de vida

Acceptance Criteria:

1. WHEN `create` solicita filha THEN o sistema SHALL criar filiação nativa no host com capacidades delegadas explicitadas e limitadas às autorizadas pelo operador. [LIF-01]
2. WHEN `create` solicita sessão em outro projeto THEN o sistema SHALL criar sessão raiz naquele projeto e vínculo explícito autorizado, sem forçar parentID incompatível. [LIF-02]
3. WHEN renomeação autorizada conclui THEN o sistema SHALL retornar o título observado no host. [LIF-03]
4. WHEN operador ou sessão com grant `session.configure` altera modelo, agente ou estilo de outra sessão dentro da política vigente THEN o sistema SHALL aplicar a seleção a execuções futuras e informar que a execução atual mantém sua configuração. [LIF-04]
5. WHEN interrupção é solicitada THEN o sistema SHALL separar a confirmação do pedido da observação de execução interrompida. [LIF-05]
6. WHEN arquivamento autorizado conclui THEN o sistema SHALL preservar histórico e suspender novos disparos automáticos destinados à sessão até restauração explícita. [LIF-06]
7. WHEN compactação ou reset é solicitado THEN o sistema SHALL distinguir redução de contexto de criação de sucessora limpa com novo ID. [LIF-07]
8. **Deferred — histórico, fora do aceite 1.0 (AD-007).** WHEN exclusão é preparada THEN o sistema SHALL retornar todos os IDs afetados incluindo descendentes, digest da seleção e token de confirmação válido por 60 segundos. [LIF-08]
9. **Deferred — histórico, fora do aceite 1.0 (AD-007).** IF a árvore muda ou o token expira antes da confirmação THEN o sistema SHALL recusar exclusão com `conflict` ou `expired` e exigir novo preview. [LIF-09]
10. **Deferred — histórico, fora do aceite 1.0 (AD-007).** WHEN o operador confirma exclusão válida THEN o sistema SHALL excluir somente o conjunto aprovado, bloquear suas pendências e remover conteúdo próprio associado, preservando auditoria mínima sem payload. [LIF-10]
11. WHEN fork é solicitado por principal com `read` e `manage` sobre a origem THEN o sistema SHALL criar novo ID com histórico autorizado e registrar linhagem sem transferir grants, jobs ou aprovações. [LIF-11]
12. WHEN o operador seleciona perfil de permissão THEN o sistema SHALL persistir o conjunto efetivo de capacidades e limites, sem ampliar grants por associação a perfil. [LIF-12]
13. WHEN uma sessão solicita criação com delegação THEN o sistema SHALL limitar as capacidades à interseção das capacidades vigentes do criador com a política de delegação previamente aprovada pelo operador, recusando excesso com `forbidden` antes de criar qualquer sessão. [LIF-13]

A delegação na criação executa uma autorização prévia do operador, não permite
que o agente emita grants novos por ACL-02. Sem essa autorização prévia, a criação
com delegação permanece aguardando operador e não cria sessão parcial.
Ordem: primeiro conferir existência da autorização de delegação; ausente, aguardar
operador. Existente, calcular interseção e recusar excesso com `forbidden`.

Independent Test: criar mãe/filha, mudar parâmetros, arquivar/restaurar, alterar
árvore após preview e verificar rejeição; testar limpeza em servidor descartável.

### P1: Orquestrar trabalho

Acceptance Criteria:

1. WHEN uma tarefa é criada THEN o sistema SHALL registrar objetivo, executor, dependências e resultado esperado com estado `pending`. [TSK-01]
2. IF dependências formam ciclo THEN o sistema SHALL rejeitar a alteração com `conflict`. [TSK-02]
3. WHEN dependências terminam com sucesso e há vaga THEN o sistema SHALL admitir uma execução da tarefa e transicionar para `running`. [TSK-03]
4. IF quatro tarefas do grupo já estão ativas ou a profundidade excederia quatro THEN o sistema SHALL manter a tarefa pendente com motivo de limite. [TSK-04]
5. WHEN executor reporta resultado final correlacionado THEN o sistema SHALL persistir `completed` ou `failed` com evidência textual e notificar a origem sem tratar evento idle como conclusão. [TSK-05]
6. WHEN dependência falha ou é cancelada THEN o sistema SHALL marcar dependentes como `blocked` até decisão explícita de cancelar ou replanejar. [TSK-06]
7. WHEN cancelamento ocorre após admissão THEN o sistema SHALL usar `cancel_requested` até confirmação do host e informar efeitos já realizados. [TSK-07]
8. WHEN uma sessão precisa de pergunta ou confirmação THEN o sistema SHALL registrar `awaiting_input` ou `awaiting_approval`, aceitando resposta somente do principal indicado no pedido. [TSK-08]
9. IF resposta de agente é recebida para aprovação humana THEN o sistema SHALL recusar a autorização e manter o pedido pendente. [TSK-09]

Independent Test: DAG com dois ramos paralelos e um join; falhar um ramo, perguntar
ao operador, cancelar execução ativa e impedir falsificação da aprovação.

### P1: Compartilhar contexto

Acceptance Criteria:

1. WHEN contexto selecionado é exportado THEN o sistema SHALL produzir pacote versionado com origem, instante, conteúdo selecionado e hash de integridade, sem grants ou credenciais de configuração. [CTX-01]
2. WHEN pacote é importado THEN o sistema SHALL aplicar o modo explicitamente selecionado: create importa o lote nativo completo em nova sessão; append mantém anexo de contexto no storage do plugin associado à sessão, acessível por ferramenta explícita cuja leitura exige context.read E read para o principal corrente e validação de owner/target, SEM reescrever histórico nativo e SEM execução no host; nenhum modo SHALL conceder permissões por conteúdo importado. [CTX-02]
3. IF pacote excede 10 MiB, tem hash inválido ou versão incompatível THEN o sistema SHALL rejeitar antes de alterar a sessão. [CTX-03]
4. WHEN transcrito completo nativo é solicitado THEN o sistema SHALL verificar compatibilidade e autorização de histórico, informando perdas e ausência de estado de arquivos/processos. [CTX-04]
5. WHEN uma chave de memória compartilhada é escrita THEN o sistema SHALL exigir revisão esperada e retornar `conflict` se outra escrita venceu. [CTX-05]
6. WHEN informação compartilhada expira THEN o sistema SHALL deixar de retorná-la e registrar tombstone sem conteúdo no próximo ciclo de manutenção de até 60 segundos. [CTX-06]
7. IF importação falha após algum efeito no host THEN o sistema SHALL retornar erro `unknown_outcome` com operationID e IDs comprovadamente criados, registrando efeitos incertos sem repetir importação automaticamente. [CTX-07]
8. WHEN chave de importação parcialmente concluída é repetida THEN o sistema SHALL retornar a operação original com IDs conhecidos e estado atual, sem criar outro destino. [CTX-08]

Independent Test: round-trip selecionado, pacote adulterado, escrita concorrente,
conteúdo que tenta conceder privilégios e expiração com relógio controlado.

### P1: Agendar e recuperar

Acceptance Criteria:

1. WHEN job é criado THEN o sistema SHALL aceitar exatamente um de timer, data, intervalo ou cron com fuso IANA e destino autorizado. [SCH-01]
2. WHEN intervalo de cinco minutos é configurado THEN o sistema SHALL calcular próximos vencimentos em incrementos de 300 segundos sem drift causado pela duração do trabalho. [SCH-02]
3. WHEN um vencimento ocorre com job anterior ainda ativo THEN o sistema SHALL coalescer em no máximo uma execução pendente daquele job. [SCH-03]
4. WHEN servidor retorna após indisponibilidade THEN o sistema SHALL registrar vencimentos perdidos e admitir no máximo uma recuperação por job ativo. [SCH-04]
5. WHEN job vence ou é disparado THEN o sistema SHALL revalidar grant e sua revisão vigente, destino, prazo e quantidade máxima na admissão LOCAL serializada do plugin, revalidando antes do envio ainda não iniciado, sem prometer revogação atômica no host após esse boundary. [SCH-05]
6. WHEN duas instâncias locais do plugin disputam job THEN o sistema SHALL permitir apenas o detentor do lease vigente criar sua admissão LOCAL por CAS no DB canônico compartilhado, sem prometer fencing atômico de efeitos externos no host; resultado incerto SHALL permanecer unknown_outcome sem retry cego. [SCH-06]
7. WHEN job é pausado ou cancelado THEN o sistema SHALL impedir próximos disparos sem afirmar cancelamento de trabalho já admitido. [SCH-07]
8. IF o serviço OpenCode está desligado THEN o sistema SHALL não prometer disparos durante esse período e expor recuperação na próxima inicialização. [SCH-08]
9. WHEN cron encontra horário local inexistente por DST THEN o sistema SHALL pular esse horário e calcular o próximo pelo fuso IANA; para horário duplicado SHALL disparar somente na primeira ocorrência. [SCH-09]
10. IF job inclui condições executáveis shell ou Code Mode THEN o sistema SHALL recusar com `unsupported` tanto para operador quanto para agente no núcleo 1.0. [SCH-10]

SCH-10 rege jobs administrados pelas ferramentas/API deste plugin. Não intercepta
chamadas diretas ao host fora do plugin; esse limite está no modelo de confiança.
AD-008 delimita SCH-05/06 ao plugin, não ao instante de admissão durável no host.
Não elimina revalidação, exclusão mútua, recuperação nem testes de corrida.
AD-009 mantém API-01/09/11 obrigatórios na 1.0: negar acesso até prova não é
retirar a API da entrega. Contrato de autenticação em
[operator-auth.md](../../../docs/architecture/operator-auth.md).

Independent Test: relógio virtual, reinício, duas localizações, job lento,
revogação e DST; intervalo e cron possuem semânticas documentadas diferentes.

### P1: API, eventos e consumo

Acceptance Criteria:

1. WHEN ferramenta ou API executa a mesma operação autorizada THEN o sistema SHALL aplicar o mesmo serviço de domínio e contrato de resultado. [API-01]
2. WHEN consumidor solicita eventos após cursor THEN o sistema SHALL retornar sequência crescente persistida filtrada pela autorização atual. [API-02]
3. IF cursor está fora da retenção de 30 dias THEN o sistema SHALL retornar `expired` e instrução de ressincronização por snapshot. [API-03]
4. WHEN duas árvores/grupos incluem a mesma sessão THEN o sistema SHALL deduplicar essa sessão no agregado solicitado. [API-04]
5. IF custo ou tokens não estão disponíveis THEN o sistema SHALL retornar valor nulo com origem/qualidade, nunca zero inventado. [API-05]
6. WHEN modelo/provedor reporta uso THEN o sistema SHALL distinguir valor reportado de estimativa e tempo ativo de tempo decorrido. [API-06]
7. WHEN uma nova admissão excede orçamento configurado com dados disponíveis THEN o sistema SHALL bloquear essa admissão e informar que execuções em andamento podem ultrapassar o orçamento. [API-07]
8. WHEN limite HTTP/RPC ou funcional falha THEN o sistema SHALL devolver erro tipado, operationID quando existente e retryability explícita sem segredos em logs. [API-08]
9. WHEN API é publicada THEN o sistema SHALL incluir schemas, autenticação, paginação, idempotência, erros, eventos, compatibilidade e exemplos HTTP/TypeScript. [API-09]
10. WHEN capability nativa obrigatória estiver ausente THEN o sistema SHALL informar `unsupported` e impedir declaração de compatibilidade completa da versão. [API-10]
11. IF principal externo não pode ser autenticado por mecanismo verificável THEN o sistema SHALL recusar a chamada e manter a superfície externa desabilitada até passar a prova de autenticação, sem desabilitar ferramentas in-process autorizadas. [API-11]
12. WHEN comando textual do núcleo é executado THEN o sistema SHALL aplicar principal, argumentos, saída e erros da tabela abaixo, pelo mesmo serviço usado nas ferramentas/API. [API-12]
13. WHEN o operador altera teto de orçamento de grupo THEN o sistema SHALL persistir a revisão, emitir `budget.changed` e aplicar o novo teto às próximas admissões, recusando alteração por principal de sessão com `forbidden`. [API-13]

### Comandos textuais do núcleo

São entrada humana autenticada pelo host; invocação originada de agente nunca se
promove a operador. Argumentos adicionais ou inválidos retornam `invalid_input`.

| Comando após `/sessions` | Argumentos | Principal | Saída |
| --- | --- | --- | --- |
| current | nenhum | Sessão autenticada ou operador com sessão atual | sessionRef e título |
| list / tree | project/cursor ou sessionRef | Autorizado por discover | Itens paginados/árvore |
| link | source, target, capabilities, expiresAt? | Operador | Grant e revisão |
| unlink | grantID, expectedRevision | Operador | revoked ou conflict |
| access-requests | cursor, status | Operador; origem vê só seus pedidos | Pedidos paginados |
| access-deny | requestID | Operador | Pedido negado |
| create | project, parentID?, grants explícitos | Operador ou manage autorizado | Novo sessionRef |
| inbox | cursor | Sessão ou operador autorizado | Envelopes |
| usage | groupID | Autorizado por read | Totais com qualidade |
| schedules | sessionRef, cursor | Autorizado por schedule.manage | Jobs paginados |
| approvals | cursor | Operador; agente só seus pedidos | Pendências |

Renomear, configurar, parar, arquivar, restaurar, compactar, resetar, fork e
exportar/importar continuam disponíveis como ferramentas/API; não exigem atalhos
textuais próprios. Perfis propostos: observe, collaborate, manage, supervised e
bounded-auto; conjuntos definidos no design e aprovados junto ao plano.

Independent Test: ferramentas e RPC contra os mesmos fixtures, reconnect com
cursor, revogação de acesso a evento, total deduplicado e custo desconhecido.

## Edge Cases

- IF banco está indisponível THEN o sistema SHALL recusar novas mutações com `unavailable`, sem efetuar ação não registrada no host. [REL-01]
- WHEN plugin recarrega THEN o sistema SHALL encerrar seus listeners e leases e reconciliar operações pendentes sem duplicar assinaturas ativas. [REL-02]
- IF sessão é removida fora do plugin THEN o sistema SHALL marcar sua referência como ausente e rejeitar novos trabalhos destinados a ela. [REL-03]
- WHEN exclusão externa é detectada THEN o sistema SHALL bloquear pendências do alvo, registrar tombstone e remover conteúdo associado do storage próprio, preservando auditoria mínima sem payload, sem excluir sessões do host nem chamar DELETE. [REL-04]
- IF uma transição não consta da tabela de estados permitidos THEN o sistema SHALL recusar a mudança com `conflict` preservando o estado anterior. [REL-05]

## Dimensões implícitas

| Dimensão | Cobertura |
| --- | --- |
| Validação/limites | MSG-09, CTX-03, SES-04 |
| Falha parcial | MSG-06, LIF-05, TSK-07, REL-01, CTX-07/08 |
| Idempotência/retry | Contrato comum, MSG-05/06, SCH-06, CTX-08 |
| Auth/rate | ACL-01..11, MSG-08, TSK-04, API-11/12, LIF-13 |
| Concorrência/ordem | MSG-07, CTX-05, SCH-06 |
| Retenção/expiração | API-03, CTX-06, REL-04, SCH-09/10 |
| Observabilidade | API-02..08, API-13, catálogo de eventos |
| Dependência externa | API-10, REL-01..04 |
| Transições | TSK-01..09, LIF-05/06, SCH-03..07, REL-05 |

## Requirement Traceability

Dos 85 IDs históricos acima, 82 pertencem ao núcleo 1.0 com status inicial `Pending`;
LIF-08/09/10 são `Deferred`, sem implementação nem aceite obrigatórios nesta versão. A matriz
[coverage.md](coverage.md) mapeia cada ID a tarefa e cenário de teste planejado.
Nenhum critério foi implementado ou verificado.

| Requirement ID | Story | Phase | Status |
| --- | --- | --- | --- |
| SES-01 | Identidade | Fundação | Pending |
| ACL-01 | Grants | Fundação | Pending |
| MSG-01 | Mensagens | Comunicação | Pending |
| LIF-01 | Ciclo de vida | Gestão | Pending |
| TSK-01 | Tarefas | Orquestração | Pending |
| CTX-01 | Contexto | Compartilhamento | Pending |
| SCH-01 | Jobs | Automação | Pending |
| API-01 | API | Integração | Pending |
| REL-01 | Recuperação | Fundação | Pending |

O índice detalhado de todos os IDs e sua cobertura está em `coverage.md`, sem reduzir
esta tabela de famílias a uma alegação de cobertura completa.

## Success Criteria

- [ ] Todos os 82 critérios ativos com testes e evidências na versão certificada; três IDs deferred preservados fora do aceite.
- [ ] Cenário A→B→resposta funciona via ferramenta e API após reinício.
- [ ] Nenhuma autoconcessão, acesso cruzado implícito ou retry cego nos testes negativos.
- [ ] Distribuição empacotada instala em ambiente limpo e documenta limitações.
- [ ] Licença final aprovada pelo titular antes de publicar código distribuível.
- [ ] Revisão independente do produto; revisão documental não a substitui.
