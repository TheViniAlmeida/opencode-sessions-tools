# T3-PROD — modelo de ameaça e plano de testes

Data: 08/11/2026. Status: **design APROVADO; core e gateway implementados e
testados somente em fixtures sintéticas; delta do gateway aguarda revisão
independente**.
Lote anterior: 24 testes/142 assertions. Lote corrigido: 29 testes/218 assertions,
zero falhas nos testes unitários/integração do core; isso não é aceite de produção.
Provisionamento e produção não autorizados por esta revisão.
Escopo: desenho do [gateway de operador](operator-auth.md) e evidência do
[incremento local sintético](operator-core-fixtures.md), sem segredo real, nova
dependência, endpoint de produto, listener persistente ou mudança de config.
O [gateway](operator-gateway.md) usa listeners loopback descartáveis de teste,
somente em porta efêmera. Não certifica produção; lifecycle do plugin, boot epoch
e provisionamento continuam pendentes.
T3-P0 provou viabilidade de transporte/lifecycle no host 2.2.5, não autenticação
de produto; evidência e histórico em [identity.md](../compatibility/identity.md).
T3-PROD continua obrigatório para API 1.0, T31/T32/T33 e emissão posterior humana.

## Ativos, confiança e garantia

Ativos: autoridade de operador; policy/grants e confirmações; integridade das
admissões e do replay store; credencial própria; disponibilidade limitada da
borda; auditoria sem payload. Banco canônico e runtime carregado são confiáveis.
DTOs, conteúdo de sessão, comandos, respostas de modelo, headers e rede local
são não confiáveis. Contexto tool comprovado identifica sessão, não operador.

Fronteiras: cliente humano → HTTP loopback → autenticador → callback lexical →
autorização/transação canônica → adaptador host. Arquivo de bootstrap → runtime é
fronteira operacional de permissões, **não isolamento contra o mesmo UID**.
O segredo não transita por tools, RPC, prompts ou respostas; essa restrição de
canal não implica que um agente com shell não possa ler o arquivo.

Garantia pretendida: entradas de produto sem credencial válida, escopo e
confirmação não admitem operação privilegiada; repetição do mesmo desafio não
admite duas vezes. Há implementação e testes de admissão local sintética;
nenhuma garantia de autenticação/transporte/isolamento de produto foi certificada.

### Adversários explicitamente fora da garantia de isolamento

- Shell irrestrito do mesmo UID, leitura de arquivo 0600, memória, `/proc`, DB
  ou acesso equivalente ao runtime. Root e comprometimento do SO também estão fora.
- Código arbitrário de plugin no mesmo processo: closure privada não é sandbox.
- Cliente/agente com credencial nativa do host que chama diretamente sua API,
  incluindo permission reply. Gateway in-process protege **policy do produto**;
  não intercepta nem bloqueia chamadas nativas com a mesma credencial.
- Roubo de bearer: atacante pode emitir desafios novos. Nonce protege replay,
  não constitui prova de posse separada nem sigilo do transporte loopback.

Aceitar esses limites é decisão explícita de operador/revisor, não teste positivo
de anti-bypass. Se a ameaça exigir bloqueá-los, separar identidades SO/processos,
credenciais e acesso nativo antes de provisionar; não chamar wrapper de isolamento.

## Ameaças e controles a provar

| Ameaça | Controle de desenho | Limite residual |
| --- | --- | --- |
| Payload/command/RPC alega operador | Principal criado só após auth na closure; entrada tool separada | Código arbitrário in-process não isolado |
| Sessão reutiliza Basic/token nativo | Credencial operador independente, escopo projeto e instalação | API nativa continua acessível a quem a autentica |
| Browser local, CSRF ou DNS rebinding | Host IP/porta exato, Origin ausente obrigatório, sem CORS, bearer | Cliente não-browser pode falsificar Host/Origin; auth é indispensável |
| Replay/alteração/concorrência | Desafio persistido ligado a bytes/hash, método, rota/op, audience, tempo e revision; consumo transacional | Captura completa pode correr pelo primeiro consumo; bearer roubado permite novo desafio |
| Retry duplica efeito após timeout | Admissão idempotente no mesmo commit; reconciliação de outcome desconhecido | Sem promessa exactly-once do host |
| Credencial revogada/cache velho | Rechecagem transacional por admissão e revision | Efeito já admitido não é desfeito |
| Confirmação trocada/renovada por retry | Aprovação humana ligada ao envelope/alvo/principal/revisão/prazo | Autenticação sozinha não aprova operação |
| DoS por chunked/slow client/desafios/IDs | Streaming, deadlines, quotas globais e por credencial, limites de conexões e registros | DoS local/OS e alocação pré-reader não eliminados |
| Vazamento por erro/audit/bootstrap | Arquivo externo 0600; logs allowlist de campos; erro genérico | Mesmo UID e backups indevidos continuam risco |
| Listener órfão ou bind alternativo | Fail-closed em bind/config e cleanup setup/unload/restart/stop | Lifecycle produto precisa testes próprios |

## Plano normativo e evidência sintética parcial

Oráculo de retry: intenção normalizada imutável e namespace
`(instanceID, operatorID, projectID, key)` definidos em operator-auth são separados
da tentativa de transporte. Nonce/challenge/tempo/credential/audience/hash HTTP
não alteram igualdade de intenção. Recuperação autenticada com autorização atual
de leitura própria precede confirmação de novo efeito; exige desafio novo, não
nova confirmação. Registry persistente impede ressurreição por arquivo antigo.
Ledger retém resultado por pelo menos 30 dias; marcador explícito de expiração
impede que purge do resultado reabra chave para redispatch.

O plano abaixo continua normativo; **nenhum ID é fechado integralmente apenas pelo
lote sintético**. O lote 29/218 cobre auth/bindings/retry locais, autorização por
port obrigatório, confirmação/revisão por hook confiável, concorrência de dois
processos e rollback de colisões geradas. AUTH-04/CNF-01 têm negativos de grant
ausente/divergente e revisão stale com bearer/confirmação válidos e nenhuma escrita
persistida; não provam composição real T11/T12. REP-04 inclui colisão PK de desafio
e UNIQUE de operationID no ledger, erro `unavailable` e retry do mesmo desafio após
gerador corrigido; reutilizar nonce com challengeIDs distintos não colapsa identidade.
REP-02 testa dois processos, não 16 concorrentes. Restart testa revogação/ledger
persistentes, não leitura/importação de bootstrap: **AUTH-05 e RET-05 completos
permanecem NÃO EXECUTADOS**, assim como transporte/lifecycle/auditoria de produto.
Usar somente chaves sintéticas conhecidas e marcadas como fixtures, banco/HOME
descartáveis, relógio controlado e dados finitos. Nenhuma credencial de produção,
modelo remoto, concessão permanente ou sessão de trabalho. Listener futuro de
teste é efêmero com cleanup em `finally`, não serviço persistente. Mudança de
allowlist/config de teste também passa pelo gate humano aplicável.

| ID | Ensaio e resultado obrigatório | Nível/evidência futura |
| --- | --- | --- |
| AUTH-01 | Ausente, incorreto, expirado, revogado e credencial nativa negados; válido só alcança escopo permitido | Unit/integration; callback e admissões zero nos negativos |
| AUTH-02 | Digest fixo e comparação por primitiva segura; DB nunca contém token bruto | Unit e inspeção independente do código; benchmark não prova constant-time |
| AUTH-03 | Payload role/operator/sessionID, command de agente e RPC não promovem principal; tool mantém contexto do host | Integration + host real descartável; não confundir stripping de campo com prova de identidade |
| AUTH-04 | Projeto/instalação/capability errados e deny explícito impedem admissão mesmo com bearer válido | Integration com autorização T10 e banco canônico |
| AUTH-05 | Arquivo ausente, proprietário/mode errado, symlink e bootstrap inválido falham sem token em erro | Integration de bootstrap sintético, sem ler arquivos externos reais |
| REP-01 | Alterar um byte do corpo, op, método, rota, projeto, timestamp ou audience impede consumo/admissão | Unit/integration, um binding alterado por caso |
| REP-02 | Mesma requisição em 16 concorrentes, dois consumidores da mesma DB: exatamente uma admissão | Integration; contagem DB e callback; repetir após restart |
| REP-03 | Nonce desconhecido, expirado, consumido e audience antiga negados; limites exatos TTL/skew testados com relógio controlado | Unit/integration, fronteiras antes/no/depois do prazo |
| REP-04 | Falha entre consumo e inserção causa rollback; indisponibilidade DB nega; nenhum fallback em memória | Fault injection antes/depois do commit |
| REP-05 | Commit com resposta perdida: novo nonce/challenge/tempo e mesma intenção/chave recuperam ID/resultado original sem enqueue/send; unknown_outcome permanece unknown | Integration com fault injection pós-commit e contador de efeitos |
| RET-01 | Mesma chave/namespace com operação, body, target, expectedRevision ou confirmationID alterado conflita; mudança de projeto não lê resultado anterior e sem escopo nega | Casos separados; nenhum efeito em conflito/deny; ordem de chaves/whitespace equivalentes preserva hash |
| RET-02 | Mesmo texto de chave em instanceID/operatorID/projectID distintos é isolado; rotação mantém operatorID e permite recuperar somente com escopo/read próprio atual | Integration com registros sintéticos distintos; operation não compõe namespace |
| RET-03 | Confirmação once consumida ou expirada não bloqueia recuperação da intenção igual com confirmationID preservado e novo desafio; sem nova permissão manage, leitura própria permitida recupera; nenhuma nova confirmação consumida | Clock controlado; contagem de consumo/efeitos inalterada; confirmação diferente conflita |
| RET-04 | Credencial revogada nega recuperação mesmo com chave/intenção originais; ledger permanece intacto; credencial rotacionada do mesmo operador com read/escopo aprovados recupera | Transações e contadores DB, sem transferir propriedade |
| RET-05 | Reboot com arquivo sintético contendo token antigo revogado nunca reativa/cria auth record; registry ausente/divergente falha fechado | Bootstrap/restart descartável; snapshot de registry antes/depois |
| RET-06 | Resultado disponível por ≥30 dias; após expiração explícita, mesma chave retorna expirado e não redispatch; nonce purge não elimina marcador de idempotência | Clock controlado em 30 dias e além; contador de admissões/efeitos inalterado |
| REV-01 | Revogação/revision antes do commit bloqueia; depois do commit não promete cancelar; rotação aceita novo e nega antigo após revogar | Dois consumidores, barreiras determinísticas de transação |
| CNF-01 | Nova admissão com bearer válido sem aprovação humana continua pendente; agente não aprova; alvo/hash/revision/prazo alterado nega; recuperação segue RET-03 sem renovar aprovação | Integration com registro de aprovação sintético |
| NET-01 | Bind não loopback, porta fora da allowlist e conflito falham sem fallback; Host errado, Origin inclusive null, preflight, proxy headers e rota/método desconhecidos não alcançam núcleo | Integration de transporte e inspeção da configuração aprovada |
| NET-02 | 64 KiB aceito quando JSON válido; 64 KiB + 1 negado; chunked sem Content-Length e tamanho declarado falso limitados antes de agregação completa | Streams finitos instrumentados; medir bytes retidos pela aplicação |
| NET-03 | Leitura >5 s, idle >2 s, headers >8 KiB e nono leitor são limitados; contador quatro de admissões é apenas defensivo | Clock e leitores testados; quinta admissão concorrente N/A por construção síncrona no gateway sintético, sem fabricar core async |
| NET-04 | Buckets no limite e +1, IDs aleatórios e desafios esgotados mantêm estruturas ≤128; nunca contornam limite global | Entradas sintéticas em quantidade fixa; clock avançado deterministicamente |
| LIFE-01 | Setup parcial, unload com host vivo, restart e stop fecham sockets e barram novas admissões; audience antiga não volta | Prova host real além de unit mock; usar baseline identity sem chamar P0 de produto |
| AUD-01 | Sentinelas sintéticas token/digest/header/nonce/body não aparecem em stdout/stderr, logs, tracing, auditoria, RPC ou transcript | Capturas locais limitadas e asserts de ausência; nunca imprimir captura bruta na falha |
| BND-01 | Demonstrar em ambiente sintético que mesmo UID pode ler arquivo 0600 e credencial nativa permite bypass do wrapper | Evidência de limite, **não** PASSOU de isolamento; não executar ação administrativa real |

TTL/skew de 30 s e quotas de quatro desafios/credencial e 128 globais foram
aprovados como defaults configuráveis apenas para limites mais estritos no core
sintético. Budgets de transporte implementados e testados no
[gateway sintético](operator-gateway.md) continuam sujeitos à revisão independente;
não são extensão silenciosa da spec nem aceite do produto. O plano de produto deve fixar resposta/status, formatos,
limites e retenção sem enfraquecer critérios ativos ACL/API/SES. Integrador mapeia
esses IDs à coverage normativa antes de implementar. Testes documentais de links
não satisfazem nenhum caso desta tabela.

Capabilities/policy e revisão atual do alvo são verificadas por
`OperatorAuthorizationPort.newEffect` obrigatório, composto com a fonte canônica
T11/T12, não por duplicação de capabilities em `operator_credentials` ou mapa de
payload host. A fixture exerce SQL por principal/intenção/capability reais dos
argumentos e consulta revisão de alvo em tabela sintética; o core somente valida
e inclui `expectedRevision` na intenção/hash. Não há default-allow nem matriz de
operações reais neste incremento.

**Disponibilidade do gateway sintético:** cleanup de até 32 desafios por chamada
elegível após expiração mais 30 s, índices exatos exigidos no startup e avaliação
de índice parcial estão implementados/testados e descritos no
[contrato do gateway](operator-gateway.md). O sweep preserva ledger/efeitos de
admissão real em fixture. Quotas não limitam todo histórico nem garantem custo
constante; revisão independente e migração pelo dono da persistência continuam
pendentes. Core/gateway não certificam operação indefinida ou lifecycle do plugin.

## Decisões e perguntas para o revisor antes de codificar/provisionar

1. Aprovar bearer + desafio server-side vinculado, sem HMAC, e aceitar expressamente
   risco de bearer capturado/mesmo UID/API nativa; se não aceitar, parar e redesenhar
   isolamento/transporte. Não inventar uma assinatura verificável por digest.
2. Confirmar aceites T9–T13 e integração transacional da DB canônica: schema,
   uniqueness, concorrência, revogação, replay, idempotência e retenção. Migração
   futura precisa autorização própria. Nunca usar outro banco de replay por atalho.
   Re-review deve aprovar intenção normalizada, namespace sem operation, identidade
   estável na rotação, precedência de recuperação, confirmação vinculada sem ciclo,
   retenção ≥30 dias e marcador durável de expiração sem redispatch.
3. Aprovar budgets propostos (body/headers/prazos/rate/concurrency/desafios), formato
   de ID/token/nonce, transporte de bindings, rotas e status genéricos. Escolher
   porta fixa somente com evidência de disponibilidade e confirmação do operador
   para porta/allowlist/env; **nenhum número de porta é decidido aqui**.
4. Definir path externo, ownership, backup, recuperação, ferramenta humana e cliente
   de bootstrap; quem consegue ler arquivo e qual identidade SO são condições de
   aceite. Secret nunca deve ser mostrado ao modelo, mesmo ao provisionar.
5. Aprovar matriz de capabilities e confirmações por operação, inclusive
   always/autoconfiguração, janela de rotação e comportamento de restart/clock.
   Confirmar como o cliente humano obtém audience sem descoberta via RPC/tool.
6. Revisar evidência de código e negativos antes de auth/provisionamento. Nova
   dependência exige autorização humana separada; T29/Effect permanece frente
   separada aguardando decisão, não é liberada por este desenho.

Saída desta etapa é proposta revisável, não fechamento de T3-PROD. Revisor aprovar
documentação não equivale a aprovar implementação, emissão ou produção. Falha de
gate bloqueia entrega; **API 1.0 continua obrigatória**, sem deferred implícito.
