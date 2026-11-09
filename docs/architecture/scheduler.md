# Scheduler próprio — contrato para T9/T29

Estado vigente de 07/11/2026: AD-007 APROVADA; docs AD-008/009 APROVADAS na
rodada posterior. Viabilidade P0 APROVADA no lote rev-p0-fechamento; T9 liberada
por ordem explícita e DAG ajustado. Implementação scheduler nas tarefas T9/T29;
auth/provisionamento em T3-PROD, sem autorização de segredo. Correções documentais
da divisão aguardam re-review; isso não revoga o aceite dos docs AD-008/009.

Status: escolha técnica ratificada após T6; implementação e revisão independente
de produto pendentes. Não é aceite de SCH-01..10; viabilidade P0 já aprovada.
Arquivo principal de T29:
`src/schedules/service.ts`. Não modifica critérios da spec, AD-007 ou o gate
pendente de autenticação/credencial.

## Decisão e evidência

Usar scheduler próprio com SQLite do plugin e dispatcher compartilhado; não criar
timer nativo correspondente nem dois executores para o mesmo job.
[T6](../compatibility/schedules.md) registra CRUD, reinício, timer one-shot e
recorrência reais no OpenCode 2.2.5. O resultado informado da rodada é 13 testes /
101 assertions; esta alteração documental não reexecutou a rodada. Reprodução:
`bun test tests/contract/schedules.test.ts`; probe `scripts/probes/schedules.ts`.

O OpenAPI e SDK público certificados oferecem somente `Schedule.Action.Prompt`.
Extras RPC/tool foram aceitos, mas normalizados para prompt, não callbacks.
O hook público de prompt transforma draft; não oferece ocorrência autenticada,
grantRevision, fence ou commit conjunto com storage do plugin. Não se presume
bypass do hook pelo scheduler. Fontes e limites runtime estão em T6, incluindo
https://opencode.ai/v2/docs/build/plugins/server#prompt-admission e
https://opencode.ai/v2/docs/api. Funcionamento do timer não prova SCH completo.

## Identidades, relógio e vencimentos

- Job: `jobID`, `scheduleRevision`, destino, principal emissor, schedule, fuso,
  prazo, limite, estado. Alterar agenda cria revisão; não renomeia ocorrências
  anteriores nem as reutiliza. Retomar sem alterar agenda preserva revisão/âncora.
- `occurrenceID` é codificação canônica versionada da tupla
  `(jobID, scheduleRevision, dueIndex)`, com UNIQUE no DB. Não depende de worker,
  momento do polling ou tentativa. A mesma ocorrência usa a mesma chave de
  operação/outbox e hash de payload; hash divergente é conflito, não nova emissão.
- Timer/data têm índice único. Intervalo calcula `anchorUTC + dueIndex * period`;
  duração da execução nunca redefine âncora. Índices e âncora persistem.
- Cron enumera instantes elegíveis em ordem desde a referência persistida da
  revisão, com índice persistente e fuso IANA. SCH-09: horário inexistente é
  pulado; duplicado usa apenas o primeiro instante. Reinício não renumera índices.
- Port de relógio injetável fornece UTC para cálculo/persistência e tempo
  monotônico para esperas locais. Salto de relógio não cria identidade nova nem
  autoriza lease por relógio particular de worker; validade usa o relógio
  autoritativo do coordenador DB, também controlável nos testes. Mudança abrupta
  de wall clock deve suspender novas admissões e reconciliar leases, não presumir
  segurança temporal externa. Não há promessa de execução com host desligado.

## Coalescing e não sobreposição

Persistir cursor e faixa/contagem dos vencimentos perdidos. Enquanto existir run
ativo, acumular no máximo um pending por job. O pending representa o primeiro
índice elegível ainda não representado e agrega índices posteriores como
coalescidos; sua identidade nunca muda. Na recuperação, admitir no máximo uma
ocorrência de catch-up por job ativo, não uma por índice perdido. Atualizar cursor,
faixa coalescida e outbox na mesma transação, inclusive em reinício repetido.

Não admitir outro run do job até resultado terminal explícito do anterior;
`idle`, `fired` nativo ou expiração do lease não provam conclusão. Resultado
incerto mantém o bloqueio. Pause/cancel/archive impedem novas admissões locais;
pendências não admitidas são bloqueadas e auditadas. Não desfazem admitted nem
prometem interromper conteúdo já enviado. Resume aplica a mesma regra de catch-up.

## Transação local e boundary externo

1. Na transação, verificar job/revisão ativos, destino, prazo, quantidade máxima,
   grant vigente e sua revisão atual, limites e ausência de run ativo. Grant salvo
   na criação não basta. Revogação e admissão local disputam o mesmo boundary
   serializado. Persistir `grantRevision` avaliada, ocorrência, reserva do limite,
   operação e intenção na transactional outbox; falha implica nenhum envio.
2. Worker adquire lease por CAS com `owner`, `generation` crescente e expiração.
   Escritas e transições exigem geração vigente; worker expirado não altera DB
   nem cria nova admissão local. Antes de sair, revalidar grant/revisão, job,
   destino, limites e lease; mudança bloqueia envio ainda não iniciado.
3. Registrar estado dispatching antes do I/O. Chamar port do host com identidade
   idempotente somente nos termos provados por T4; persistir recibo e estado
   admitted quando observáveis. Admitido não é inferência concluída. Reserva de
   limite incerta permanece ocupada até reconciliação; não liberar para duplicar.
4. Crash/timeout após possível saída cria `unknown_outcome`. Recuperação consulta
   evidência de recibo/identidade demonstrada por T4. Sem prova conclusiva, manter
   bloqueado e solicitar resolução explícita; não retry cego. Outbox durável não
   significa exactly-once no host.

SQLite e host não compartilham transação. Existe janela entre último check e
chamada ao host: worker pode perder lease ou grant ser revogado nesse intervalo.
Sem CAS/fencing reconhecido pelo host, fence do DB **não impede** efeito externo
de worker expirado que já passou pelo check. Revalidação reduz a janela, não a
elimina; lock/lease local tampouco revoga bytes enviados. Após saída ao host o
plugin não promete revogação. Não afirmar que worker expirado jamais produz efeito
externo, nem atomicidade entre autorização, outbox e admissão nativa.

## Duas localizações e ownership

Localizações do plugin que gerenciam o mesmo host/escopo compartilham uma única
identidade de instalação e DB canônico fora dos repositórios. Chave do recurso do
lease inclui instalação e job; unicidade de ocorrência, run ativo e outbox é
garantida no DB compartilhado, não por singleton em memória. Hot reload remove
listeners/loops próprios sem apagar estado durável. Dois processos devem competir
no mesmo DB real no teste. DBs isolados não coordenam o mesmo job: falhar fechado
ao detectar ownership incompatível; não declarar suporte multi-host/distributed
SQLite nem certificar ownership sem prova no bootstrap. Caminho e mecanismo de
detecção ficam para T9/T10; não inventar descoberta global entre bancos isolados.

## Boundary autorizado — AD-008, 07/11/2026

O termo «admitir» significa admissão local autorizada do produto ou o instante de
admissão durável no host? Na primeira interpretação, transação/CAS prova grant e
lease no boundary local, com janela externa explicitamente exposta. Na segunda,
garantia estrita exige primitiva host de autorização/fencing atômicos que T6 não
demonstrou; backend próprio sozinho também não a satisfaz.

Decisão do operador: a primeira interpretação acima é a autorizada, admissão
LOCAL serializada do plugin, não admissão durável atômica no host. Garantir
grant/revisão e lease localmente; expor a janela externa e a irreversibilidade da
saída. unknown_outcome permanece bloqueado sem retry cego. Revisão independente
e provas de implementação continuam pendentes; viabilidade P0 já aprovada,
sem alterar AD-007 ou certificar aceites do produto.

## Testes deriváveis, ainda não executados

| Critérios | Cenário e observável exigido |
| --- | --- |
| SCH-01/10 | Exatamente um tipo, destino autorizado, entrada inválida e condições executáveis recusadas |
| SCH-02 | Relógio virtual: execução longa e reinício preservam incrementos de 300s e identidade |
| SCH-03 | Vários índices vencidos com run ativo: um pending; nenhum segundo run até terminal explícito |
| SCH-04/08 | Downtime atravessa vários índices; faixas auditadas, um catch-up; segundo restart não repete |
| SCH-05 | Revogar/expirar/mudar revisão antes da transação e antes do envio; negar; corrida após check evidencia limite, não sucesso fictício |
| SCH-06 | Dois processos/localizações no DB canônico: uma ocorrência/outbox; worker antigo falha CAS; DBs incompatíveis recusados |
| SCH-05/06 | Barreira check→host com lease expirado/revogação: provar exclusão local e demonstrar janela externa sem fence, sem alegar atomicidade no host (AD-008) |
| SCH-07, LIF-06 | Pause/cancel/archive antes/depois da admissão: futuros bloqueados, admitted não desfeito |
| SCH-09 | America/New_York: 08/03/2026 02:30 pulado; 01/11/2026 01:30 somente primeiro instante; repetição e restart preservam índice |
| REL-01/02, SCH-06 | Crash antes/depois de commit, saída e recibo; rollback não envia, unknown_outcome não reenvia nem libera overlap |

Unit cobre calendário/clock/identidade; integração usa SQLite real, falhas e dois
processos; contract usa host certificado e fronteiras de T4. Teste deve observar
efeitos externos, não só linhas no DB. Revisão independente valida a discriminação
dos testes e a interpretação SCH-05/06 antes de fechar T29.
