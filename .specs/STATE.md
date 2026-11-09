# Estado do projeto

## Decisions

| ID | Estado | Decisão | Origem |
| --- | --- | --- | --- |
| AD-001 | active | OpenCode V2, uma instância, vários projetos na primeira versão | Operador, 06/11/2026 |
| AD-002 | active | TUI e web juntas em etapa posterior; núcleo/API primeiro | Operador, 06/11/2026 |
| AD-003 | active | Uso profissional e reutilização permitidos; venda do plugin por terceiros proibida | Operador, 06/11/2026 |
| AD-004 | active | Comunicação no projeto; acesso adicional concedido por comando explícito | Operador, 06/11/2026; interpretação detalhada em context.md |
| AD-005 | superseded | Documentar, especificar, revisar até passar, depois planejar; sem implementar naquele momento. Superada pela autorização de implementação em 07/11/2026 | Operador, 06/11/2026; autorização posterior, 07/11/2026 |
| AD-006 | active | Paralelismo em trabalhos independentes, com integração e revisão | Operador, 06/11/2026 |
| AD-007 | active | Retirar exclusão destrutiva de sessões da 1.0; manter archive/restore, tratamento de exclusão externa e limpeza do storage próprio. LIF-08/09/10 históricos deferred; produto não chama DELETE nem expõe delete-preview/delete-confirm | Operador, 07/11/2026 |
| AD-008 | active | Scheduler próprio garante grant/revisão e lease na admissão LOCAL serializada do plugin; não promete revogação/fencing atômicos no host. Resultado externo incerto permanece unknown_outcome, sem retry cego | Operador, 07/11/2026 |
| AD-009 | active | Projetar credencial própria de operador da API, separada de sessões; validar canal em T3 e revisar armazenamento/provisionamento antes de qualquer emissão humana posterior de segredo | Operador, 07/11/2026 |
| AD-010 | active | CTX-02: create por lote nativo completo em nova sessão; append na 1.0 como anexo no storage plugin associado à sessão, acessível por ferramenta explícita, sem reescrever histórico nativo nem execução host | Escolha explícita do usuário «Anexo de contexto (Recomendado)», relatada na solicitação documental de 08/11/2026 |

## Handoff

### Atualização de implementação — 08/11/2026

Nota vigente AD-010: domínio T27 APROVADO pelo revisor 43 testes/328 assertions;
root v23 APROVADA 15/77. Adapter nativo 6/28 aprovado; refinamento autor 10/47
aguarda follow-up independente. Lotes informados pelo revisor/integrador, sem
reexecução nesta atualização documental. Fixtures/adapter não certificam execução
nativa real ou E2E/full. Reabertura anterior superada apenas no domínio. Escolha
do usuário «Anexo de contexto (Recomendado)» mantém append na 1.0 no storage
plugin, recuperável por ferramenta explícita exigindo `context.read` E `read`,
principal corrente e owner/target, sem concessão de grants, histórico reescrito ou
execução host. CTX-02 e 85 históricos/82 ativos preservados. Sem teste executado
neste lote documental ou novo gate global. Licença, AD-007, boundary RPC/auth e
hardening separado do registry de operador não alterados.

Estado de schema informado no lote root aprovado: CURRENT 23, reconhece versões
20..23; anchors preservadas, descriptor 15 restaurado e novo attachment em 23.
Não reinterpretar blocos históricos abaixo como CURRENT 21 ou autorização para
editar migrations. Este registro documental não altera código/schema executável.

Histórico anterior à reabertura T27: domínios T9–T28 e T30 implementados e
revisados independentemente, com limites
de adapters/wiring registrados nas tarefas. A aprovação de domínio não é aceite
da superfície de produto. T29 teve autorização explícita para dependência runtime
direta `effect@4.0.6`; manifesto/lock atualizados e implementação retomada.
T31–T36 permanecem pendentes.

T3-PROD: design, core e gateway SINTÉTICOS aprovados; core+gateway 56 testes/512
assertions confirmados pelo revisor. Lifecycle no host 2.2.5 também aprovado:
1 teste/27 assertions reexecutado pelo integrador e revisor, unload/re-enable,
epoch e retry após restart sem duplicar efeito. São fixtures públicas, não
credenciais operacionais. Provisionamento, allowlist operacional, ownership pelo
Persistence real e auditoria de logs ainda não validados; T3-PROD continua aberto.
Nenhuma emissão de segredo, porta fixa ou configuração de trabalho autorizada.

Os lotes abaixo são históricos; não representam a contagem atual da suíte.

Implementação solicitada em 07/11/2026 após aprovação do plano pelo operador.
Implementação em andamento; P0 de viabilidade APROVADO pelo revisor no lote
`rev-p0-fechamento` (45 contract / 401 assertions, evidência recebida).
Ordem explícita atual: «Aplique o ajuste no plano e inicie a T9». T9 CONCLUÍDA:
contratos e testes revisados independentemente, APROVADO. Integrador: 9 testes
unitários/215 assertions, lint incluindo src e typecheck passaram. Revisor:
suíte completa 64 testes/742 assertions, sem falhas. Não é aceite do produto.
T3 principal agora é T3-P0 aprovado; subgate T3-PROD pendente depende da fundação
T9–T13 e bloqueia T31/T32/T33 e emissão de segredo. API obrigatória na 1.0;
hardening, humano versus agente/always e revisão de armazenamento/provisionamento
permanecem no subgate de produto. Nenhuma emissão real de segredo autorizada.
Rodada anterior de 07/11/2026 APROVOU documentação AD-008/009
e probe SES-01 (contexto tool em fixture host 2.2.5; claims ignorados, não operador).
Essa rodada anterior não aprovava P0; foi superada para viabilidade pelo lote
rev-p0-fechamento, sem aprovar auth de produto. AD-007 permanece APROVADA.
Unload isolado do pacote e cleanup do listener comprovados no host 2.2.5:
[identity.md](../docs/compatibility/identity.md). Lote posterior de 07/11/2026
confirmado pelo revisor: artifact 3/28 e runtime 7/111; não executado nesta rodada.
P0 cobre viabilidade dos probes T1–T8, não exige antecipar aceites de produto
T31–T36. Limitações do host, viabilidade e implementação são avaliações distintas;
aceites futuros permanecem nas tarefas respectivas. DAG ajustado explicitamente
para distinguir T3-P0 de T3-PROD, sem ciclo ou antecipação de gates de release.
T1 concluída: harness isolado, build e testes; revisão independente APROVADA após
correções. Histórico do lote inicial de 07/11/2026 informado pelo integrador
(não é contagem vigente): T1 5 testes/47 assertions; contratos T2/T5/T7
15 testes/96 assertions. Não confundir probes com implementação do produto.
Lote posterior relatado pelo integrador em 07/11/2026: integration 7 testes/98
assertions e artifact 3 testes/22 assertions. Registro de evidência recebida, não
nova execução nesta atualização documental; não tratar como contagem universal.
Autorização explícita para dependências locais fixadas, configuração em
`/tmp/opencode`, servidor loopback descartável e remoção restrita dos seus dados
sintéticos. Servidor de trabalho e configurações globais não podem ser alterados.

Base: ca1dcd0, branch `docs/session-orchestration-spec`. Spec com 85 IDs históricos (82 ativos e 3 deferred),
plano de 36 tarefas em oito fases, 82 dependências Tn e um subgate normativo
T3-PROD com oito edges adicionais (90 edges totais), contagem documental medida
nesta rodada. Runtime de produto ainda não certificado; P0 é viabilidade.
T2 produziu snapshot servido 2.2.5; T5 comprovou corrida de exclusão recursiva:
filha criada depois da validação também é apagada. LIF-09/10 NO-GO; exclusão do
produto permanece fora da 1.0 por AD-007. Evidência histórica preservada em
[T5 lifecycle](../docs/compatibility/lifecycle.md); DELETE só no probe sintético autorizado,
nunca no produto. Revisão independente desta mudança de escopo: **APROVADA**;
aprovações documentais anteriores permanecem históricas. T7 prova round-trip e perda de
resposta, não atomicidade nem ledger persistente. Acompanhamento local no AgentZero:
`.ai-data/todos/2026-11/todo-opencode-sessions-implementation-071126.md`.
