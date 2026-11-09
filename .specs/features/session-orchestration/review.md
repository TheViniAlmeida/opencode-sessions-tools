# Revisão documental

Escopo: prontidão da spec e do plano. Não é validação de implementação, segurança
runtime, licença jurídica ou compatibilidade com servidor real.

## Rodada 1 — spec

Veredito independente: **REPROVADO**. Sete bloqueadores apontados e corrigidos:

| Achado | Correção |
| --- | --- |
| Condições de agenda podem executar código sem política | SCH-10 recusa shell/Code Mode no núcleo |
| Autenticação externa sem fail-closed | API-11 desabilita superfície externa sem prova |
| Configuração sem principal/teto de política | ACL-10/11 e LIF-04 tornam autorização explícita |
| Solicitações de grant e comandos incompletos | ACL-08/09 e API-12 definem ciclo e comandos |
| DST sem resultado esperado | SCH-09 define skip e primeira ocorrência |
| Importação parcial sem recuperação | CTX-07/08 registram IDs, incerteza e retry idempotente |
| Estados não enumerados | Tabela fechada e REL-05 recusam transições inválidas |

Também definidos: destino sessionRef, comportamento de exclusão de grupo, escopo
do orçamento, catálogo mínimo de eventos e campos de auditoria.

## Validação estrutural

Em 06/11/2026, `validate_spec.py .../spec.md --strict`: zero erros, zero avisos.
Este resultado prova estrutura documental, não execução dos critérios.

## Rodada 2

Veredito independente: **REPROVADO**. Os sete achados anteriores foram resolvidos;
foi detectado um caminho restante de escalada por delegação na criação de filha.
LIF-13 limita a interseção de capacidades antes da criação. Também foram fechados
escopo de SCH-10, erro inicial de importação parcial, perfis e revisão de orçamento.

## Rodada 3

Veredito independente: **APROVADO** para elaboração do plano. LIF-13 fecha a
escalada por criação de filha. Não bloqueantes incorporados: tabela normativa de
comandos referenciada no design e ordem de avaliação da delegação explícita.

Permanecem gates do operador/execução: confirmar interpretação de comunicação
mínima no projeto, aprovar defaults e provar capacidades no runtime em P0.

## Revisão do plano — APROVADO

Registro histórico da revisão anterior à AD-007; não aprova automaticamente a mudança de 07/11/2026.

Revisão independente confirmou 36 tarefas, oito fases, 82 arestas consistentes,
85 critérios mapeados, arquivos de trabalho separados e gates P0 preservados.
Não houve bloqueadores. Ajustes não bloqueantes incorporados: autoridade de
coverage.md, entrypoint sob T33, runner probe explícito em T1, docs após T33,
cenários de aceite vinculados e convenção de acompanhamento declarada.

## Validações finais da documentação

- `validate_spec.py .../spec.md --strict`: zero erros, zero avisos.
- `validate_tasks.py .../tasks.md --strict`: zero erros, zero avisos.
- Conferência independente dos 85 critérios: IDs únicos e forma EARS com SHALL.
- Comparação integral do DAG com Depends on: 82 arestas, sem ciclos.
- Matriz: 85/85 critérios com tarefas existentes e cenários nomeados.
- Links locais e whitespace conferidos; `git diff --cached --check` sem achados.

Essas verificações não executam o plugin. Todos os testes funcionais e a aprovação
de compatibilidade permanecem no plano. Não se criou `validation.md` de produto.

## Mudança AD-007 — 07/11/2026 — revisão APROVADA

Operador autorizou retirar exclusão destrutiva de sessões da 1.0, mantendo
archive/restore. AD-005 fica superada pela autorização posterior de implementação.
Os resultados APROVADO e as contagens de validação acima permanecem históricos.

- 85 IDs históricos: 82 ativos e LIF-08/09/10 deferred, sem renumeração.
- T18 substituída por exclusão externa, tombstones e limpeza do storage próprio
  (REL-03/04); T31/T32 continuam dependentes desses serviços, não de delete.
- Sem ferramenta, comando ou API delete-preview/delete-confirm; produto não chama DELETE.
- Retenção própria não é exclusão de sessão host. DELETE só em probe sintético autorizado.
- [Achados runtime T5](../../../docs/compatibility/lifecycle.md) preservados, inclusive NO-GO de exclusão exata.

Gate: revisão independente desta mudança **APROVADA**, distinta do aceite
do produto e das aprovações históricas. Conferência mecânica de links/IDs não
substitui esse gate.

### Checklist mecânico desta mudança

- [x] 85 IDs únicos na spec e igualdade com os IDs da matriz.
- [x] 82 ativos e exatamente 3 deferred: LIF-08, LIF-09 e LIF-10.
- [x] 36 tarefas preservadas; 82 arestas do DAG iguais a `Depends on`.
- [x] Links Markdown locais dos nove documentos alterados apontam para arquivos existentes.
- [x] Ausência de whitespace final nos nove documentos.
- [x] Revisão independente de AD-007 e do novo escopo de T18: APROVADA; 82 ativos, três deferred e ausência de DELETE pelo produto conferidos.

Conferência executada em 07/11/2026 com Python (leitura de Markdown e assertions),
sem comandos Git, alteração de scripts ou execução de testes runtime. Não valida
âncoras remotas, implementação nem aprovação independente.
## Histórico: rodada AD-008/009 — 07/11/2026 — REPROVADO (superado)

Estado histórico abaixo superado pelo aceite documental posterior e pelo lote
rev-p0-fechamento para viabilidade. Não representa bloqueio atual de T9.

Retorno independente: scheduler AD-008 sem objeção; AD-009 REPROVADO.
Correções documentais aplicadas, sem novo aceite independente:
1. Tools: identidade NÃO VALIDADA T3; operador fail-closed.
2. Gateway preferido no setup/mesmo processo, callback lexical privado; separado
   assinado só alternativa. Gates: loopback/porta allowlisted não publicada por
   RPC/tool, Host/Origin, streaming antes de alocar, anti-replay e cleanup.
   `docs/compatibility/identity.md` distingue mock de host; unload isolado pendente.
3. AD-007 APROVADA; AD-008/009 aguardam re-review, sem GO de P0.
4. T3 referencia operator-channel/fixtures/evidência; setup orienta integrador;
   coverage distingue fencing local e T9 exige contrato de ownership.

DAG preservado: núcleo tecnicamente implementável não autoriza T9 antes de P0.
Contagens anteriores são históricas por lote, não nova medição. Não executados
testes runtime nesta rodada documental. Preservados 85 IDs históricos/82 ativos.
## Rodada posterior — 07/11/2026 — APROVADO com escopo limitado

Revisor APROVOU documentação AD-008/009 e probe SES-01. Contexto de tool
comprovado na fixture do host 2.2.5, claims recebidos ignorados; não é operador.
Supera a pendência de re-review documental da rodada anterior, preservada abaixo.
Não aprova P0, autenticação de produto ou T3 completo. Continuam pendentes comando
humano, always, armazenamento/provisionamento e auth de produto.
Nenhuma emissão de segredo autorizada; T9 continua dependente de P0, sem alteração
do DAG. AD-007 preservada; 85 IDs históricos e 82 ativos.
Contagens relatadas do lote posterior de 07/11/2026: integration 7/98 e artifact
3/22; histórico inicial T1 5/47 não é baseline vigente. Nenhum teste executado
nesta atualização documental e nenhuma nova aprovação técnica presumida.

### Atualização posterior do mesmo dia — lifecycle e lote confirmado

Superada a pendência histórica de unload acima: unload isolado do pacote e cleanup
do listener comprovados no host 2.2.5; evidência em
[identity.md](../../../docs/compatibility/identity.md), mantida pelo outro worker.
Lote posterior confirmado pelo revisor em 07/11/2026: artifact 3/28 e runtime
7/111. Os lotes 5/47, 7/98 e 3/22 acima são históricos, não contagens vigentes.
Nenhum teste executado nesta correção documental.

P0 é prova de viabilidade T1–T8, não antecipação dos aceites de produto T31–T36.
Limitação do host não se confunde com inviabilidade do desenho nem com ausência
de implementação futura; cada aceite de produto permanece na tarefa respectiva.
Continuam pendentes humano versus agente, always, auth de produto e
armazenamento/provisionamento. Sem GO de P0, sem alteração de DAG, sem autorização
de T9 ou emissão de segredo. Docs AD-008/009 e SES-01 mantêm seu aceite limitado;
AD-007 e contagem 85 históricos/82 ativos preservados.
## Rodada vigente — rev-p0-fechamento e ordem de início de T9 (07/11/2026)

Revisor APROVOU viabilidade P0: lote rev-p0-fechamento, 45 contract / 401
assertions, registrado como evidência recebida, não teste executado neste lote.
Operador ordenou: «Aplique o ajuste no plano e inicie a T9». Divisão aplicada;
T9 iniciada pelo worker de código paralelo, sem aguardar nova revisão para
contrariar a ordem. Código/conclusão de T9 não são certificados por este registro.

T3 é ID principal do gate T3-P0 aprovado; T9 depende de T3-P0 e T4–T8.
T3-PROD é subgate normativo pendente de T3, depende da fundação T9–T13 e exige
contrato de produto completo/revisão antes de T31/T32/T33 e qualquer emissão de
segredo. Humano versus agente, always, auth/hardening e revisão de
armazenamento/provisionamento não foram aprovados. Nenhum segredo real autorizado.
P0 não exige antecipar T31–T36; viabilidade, limitações host e aceites de produto
permanecem distintos. Registros anteriores de bloqueio de P0/T9 estão superados
neste escopo, preservados como histórico. AD-007 e 85 históricos/82 ativos intactos.

Verificação documental por leitura/parse: 36 tarefas principais, 82 edges Tn
iguais aos Depends on; subgate único com oito edges adicionais, 90 totais,
grafo acíclico. Não foi encontrado validador de schema de tarefas no repo; IDs
T1–T36 e formato Depends on Tn preservados, supporting gate explicitado à parte.
Nenhum script, código, teste ou runner alterado; sem execução de testes de produto.
## Correções de coerência da divisão — aguardando re-review (07/11/2026)

Retorno independente: split/DAG PASS; documentação REPROVADA por dois pontos de
coerência. Corrigidos estados normativos stale em spec/context/design/scheduler,
tools/unload e advisory de T9, além de setup/operator-auth, heading de coverage
e typo memo→mesmo. Docs AD-008/009 e AD-007 continuam APROVADAS; a pendência de
re-review é destas correções da divisão, não revogação de aprovações históricas.
Viabilidade P0 APROVADA em rev-p0-fechamento; T9 segue por ordem explícita no
worker separado. Auth/provisionamento de produto permanecem T3-PROD, sem segredo.
