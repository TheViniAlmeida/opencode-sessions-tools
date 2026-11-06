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
