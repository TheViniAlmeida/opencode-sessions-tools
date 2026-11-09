# T8 — fontes e qualidade de uso

Prova executada em 07/11/2026, ambiente privado `createHarness`, OpenCode
`v2.2.5`, pacotes plugin/client instalados 2.2.5. Fluxo 4 com gate sintético
recebido do integrador. Não implementa T30, faturamento ou bloqueio de orçamento.

## Reprodução e integração

```sh
bun scripts/probes/usage.ts
bun test tests/contract/usage.test.ts
bun run typecheck
```

Runner: importar `runUsageProbe` de `scripts/probes/usage.ts`, cenário `usage`.
O worker não altera runner/harness. Reutiliza somente `fixture` e `importPath`
de T7. Testes: **3 pass, 0 fail, 27 assertions**; typecheck passou.
Nenhuma dependência instalada, chamada a modelo, chave externa ou sessão pessoal.

## Evidência HTTP real

| Fonte | Resultado | Qualidade e limite |
|---|---|---|
| Import/export experimental | Dois imports 200; exports 200 | Mensagem assistant conhecida preserva `cost=0.125`, input 101, output 17; mensagem desconhecida omite cost/tokens e a projeção retorna `null/unavailable`. |
| GET sessão | 200 nos dois casos | Total conhecido 0.125; fixture desconhecida tem total obrigatório explicitamente 0. Esse zero importado não prova custo conhecido da mensagem. |
| Stats experimental | Antes/depois 200 | Delta custo 0.125, input 101/output 17, duas sessões, dois steps, zero prompts, um modelo sintético. Conta também o step sem custo/tokens. Ausência de uso vira zero no agregado: não serve como prova de completude. |
| Atividade stats | `[{date:"2026-11-07",steps:2}]`, activeDays/streak 1 | Contagem diária de steps, não duração ativa; intervalo sessão/mensagem não mede CPU nem execução ativa. |
| Log por sessão, follow=false | 200, somente `log.synced`, sem eventos de domínio | Mesmo após PATCH título 204 e synthetic resume=false 200, as sessões importadas não forneceram cursor histórico. Replay efetivo permanece NÃO VALIDADO, não inexistente. |
| Stream global | 200 e primeiro frame recebido; conexão cancelada | Handshake observado, não prova entrega de usage events. Documentação o define volátil, sem replay. |

O custo conhecido é **valor sintético importado**, não cobrança do provedor,
estimativa de preço ou uso reportado por inferência real. `metric` aceita zero
explícito e rejeita ausente/null/negativo/não finito/string como desconhecido.
A qualidade `synthetic_import` pertence exclusivamente a este probe, não a uma
taxonomia de produção. Não somar totais de sessão e mensagens: são duas visões
do mesmo uso. Deduplicação de grupos sobrepostos cabe à T30.

## Schema observado versus semântica

- `Session.Info`: cost e tokens obrigatórios; não carrega qualidade/proveniência
  financeira. `Session.Message.Assistant`: cost/tokens opcionais.
- `SessionStats.Info`: range, sessions, subagents, prompts, steps, tokens, cost,
  tools, activeDays, streak, activity e models. `activity` contém date/steps.
- Stats recebe `from/to/project/timezone/tools`, sem cursor/limit. Foram usados
  limites epoch-ms como strings e `America/Belem`, tools=none. Tentativa inicial
  com datas ISO retornou 500; não assumir que qualquer string documentada funciona.
  Default sem intervalo retornou range com from=to e zeros no host vazio.
- Log recebe `sessionID/after/follow`. Docs especificam sequência agregada
  exclusiva e follow contínuo; não é paginação limit/cursor de listagem.
  Probe só tenta after quando encontra evento histórico com cursor; nunca usa
  `log.synced` como evento de domínio nem inventa replay a partir de contrato.
- `/api/event` recebe types, não after. A descrição servida declara perdas na
  desconexão e falha por consumidor lento; esses limites são contratuais, não
  testes de overflow/reconexão executados aqui. A ausência de replay foi lida
  na documentação, não inferida de handshake.

## Fontes escolhidas para próxima fase

Uso por mensagem: projeção assistant, preservando ausência e origem. Total de
sessão: snapshot nativo apenas quando sua procedência/completude for conhecida.
Stats: visão descritiva por intervalo/projeto/fuso, inadequada como ledger
financeiro exato. Atividade: contagens diárias separadas de elapsed/active time.
Eventos live: sinal de reconciliação; snapshot/log e journal próprio precisam
ser avaliados separadamente para API-02/03.

**NÃO VALIDADO:** replay com eventos de execução, restart do log, retenção e
expiração, overflow, paginação de mensagens, valores reportados pelo provedor,
estimativas, cache cobrado, duração ativa e orçamento concorrente. Não houve
chamada de modelo para fabricar essa evidência. O retorno `state=observed`
significa import/export observado, não aprovação integral de API-02..07.

Fontes lidas: [API V2](https://opencode.ai/v2/docs/api), OpenAPI servido privado,
`docs/research.md`, spec/design/tasks locais. Context7
`/websites/opencode_ai/v2`, consulta focada em stats/tokens/cost/activity/log:
corroborou stats e `after` exclusivo/follow; contrato não substitui runtime.
