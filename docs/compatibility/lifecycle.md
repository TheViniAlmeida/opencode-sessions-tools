# T5 — ciclo de vida: NO-GO para exclusão exata

Baseline observada: **OpenCode 2.2.5**, Bun 1.4.3, em 07/11/2026.
Este relatório descreve um probe destrutivo autorizado **somente em sessões
sintéticas do servidor isolado**. Não implementa serviço de exclusão do produto.

## Fontes e reprodução

- [API V2 oficial](https://opencode.ai/v2/docs/api), consultada antes das chamadas.
- [Snapshot T2](contracts-baseline.json): OpenAPI servido SHA-256
  `f5c4571bf7e9afc22a440875a746f593f988c4c31bf824f602601c04b20e6c8e`.
- Context7 `/websites/opencode_ai` foi consultado; retornou exemplos V1
  (`/session`, `messageID`, `abort`). **Não foram usados como contrato V2.**
- Implementação: `scripts/probes/lifecycle.ts`.
- Contrato executável: `tests/contract/lifecycle.test.ts`.

```sh
bun scripts/probes/lifecycle.ts
bun test tests/contract/lifecycle.test.ts
bun run typecheck
bun run lint
```

O probe usa `createHarness().request(path, init)`, que restringe origem e injeta
autenticação efêmera sem imprimi-la. Não usa servidor de trabalho, SDK, banco
interno, configurações globais ou credenciais de provedor. O `finally` exclui
somente IDs retornados por criações/importações próprias e encerra o harness.
O relatório contém somente fixtures sintéticas; erros HTTP são reduzidos a status.

**Integração pendente do condutor:** registrar `lifecycle` em `scripts/probe.ts`.
Até esse registro, usar o comando direto acima; não anunciar `bun run probe --
lifecycle` como disponível. Nenhuma alteração de runner faz parte desta entrega.

## Resultados nativos

| Operação | Evidência real | Limite |
| --- | --- | --- |
| Create | HTTP 200; filha retorna `parentID` da mãe; ambas preservam `location.directory` explícito | Não prova delegação de capacidades LIF-01/13 nem outro projeto LIF-02 |
| Fork | HTTP 200; novo ID, `fork.sessionID`, boundary `through`, cópia de mensagem sintética | Fonte com histórico importado; sessão vazia retornou 400 em diagnóstico. Não prova isolamento de grants/jobs do plugin |
| Rename | PATCH 204, seguido de GET com título alterado | Recibo sem conteúdo não é observação |
| Archive/restore | PATCH 204; GET mostra timestamp `time.archived` e depois ausência; histórico sintético sobrevive | Suspensão de jobs LIF-06 é responsabilidade futura do plugin |
| Agent | POST `/agent` 204; GET observa `build` | Não houve execução de modelo para comprovar seleção futura |
| Model | Seleção de provedor/modelo sintéticos inexistentes retorna 400 | Nenhum modelo válido executado; LIF-04 não certificado |
| Style | Nenhuma operação dedicada no snapshot T2 | Unsupported para configuração nativa dedicada; sem inventar API |
| Interrupt | HTTP 200 em sessão sem execução de modelo | Pedido confirmado não prova interrupção de execução ativa LIF-05 |
| Compact | HTTP 200 com ID de item `compaction`; mensagem do mesmo ID termina `failed`, `compaction.unavailable`, `Nothing to compact yet` | Admissão não é compactação concluída; nenhuma redução de contexto provada |
| Reset | Não há primitiva dedicada exercitada | Sucessora limpa deve ser criação distinta; LIF-07 completo não certificado |

## Escritor externo após validação: violação reproduzida

Ordem controlada e registrada no resultado, sem corrida probabilística:

1. Criar mãe A e filha B, ambas sintéticas; preparar seleção `[A, B]` e SHA-256.
2. Revalidar A por GET 200 e B por GET com `parentID = A`.
3. **Depois da validação**, outra chamada HTTP nativa cria filha C com `parentID = A`.
   Essa chamada não passa por lock do suposto plugin. GET de C confirma 200.
4. Executar `DELETE /api/session/A` sem incluir C na seleção aprovada.
5. DELETE retorna 204; GET de A, B **e C** retorna 404.

O OpenAPI servido aceita somente `sessionID` no path do DELETE: nenhum body,
CAS, revisão ou conjunto esperado. O digest local não é enviado nem verificado
pelo host. Isso demonstra uma janela entre validação e exclusão na qual um
escritor externo amplia a cascata. Lock interno e nova leitura antes da chamada
não fecham essa janela.

**Veredito: NO-GO LIF-09/LIF-10.** O teste passa quando detecta essa limitação
observada, não porque o requisito do produto esteja atendido. O probe sempre
retorna `productDeleteEnabled: false`. Uma mudança de comportamento do host deve
quebrar o teste e motivar reavaliação, não liberar o produto automaticamente.
Não foi implementada exclusão insegura nem alegada suficiência de token de 60s.
LIF-08, autorização e expiração do token ainda exigem o serviço de domínio.

## Referências e reconciliação

Uma raiz independente permanece GET 200 após a cascata, enquanto uma referência
local sintética dela para A fica pendente de reconciliação porque A retorna 404.
A referência é somente um objeto do probe, **não** storage implementado do plugin.
Separadamente, excluir a fonte sintética do fork retorna 204 e o fork permanece
GET 200: linhagem `fork.sessionID` não equivale a filiação `parentID`.

REL-03 tem evidência de ausência observável por GET 404. REL-04 e limpeza de
conteúdo próprio/auditoria LIF-10 continuam **não implementados/não provados**.
LIF-12/13 e perfis/grants são obrigações do produto, não capacidades inferidas de
HTTP autenticado. T18 deve permanecer bloqueada até solução revisada que preserve
o conjunto exato contra escritores externos; não reduzir a spec silenciosamente.

## Verificação local

O contrato inclui sete testes reais sobre um único harness descartável, sem mocks
de resposta do host. A prova é de compatibilidade/limitação P0, não aceite 1.0.
Typecheck e lint usam apenas as ferramentas já instaladas no repositório.
