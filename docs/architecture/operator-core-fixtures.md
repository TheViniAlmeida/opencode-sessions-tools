# Operator core — decisões do incremento sintético

08/11/2026. Escopo autorizado: núcleo local e testes sintéticos. Não certifica
produção, gateway HTTP, emissão, bootstrap, transporte ou integração T29.
Status: **core implementado e testado somente em fixtures; gateway implementado
e testado em incremento separado, com delta aguardando revisão independente**.
Lifecycle real do plugin, boot epoch e provisionamento permanecem pendentes.
Lote anterior: 24 testes/142 assertions.
Lote corrigido: 29 testes/218 assertions, zero falhas nos dois arquivos do core.

- Igualdade da intenção usa o contrato `canonical` existente: `1`, `1.0`, `1e0`
  são iguais, assim como `-0`/`0`. Strings não sofrem trim/normalização Unicode.
  O hash do transporte usa os bytes UTF-8 exatos; outra representação exige novo
  desafio, mas pode recuperar a mesma intenção. Parser JSON rejeita duplicatas,
  inclusive chaves escapadas equivalentes, antes do parse final; profundidade 64
  e tamanho 64 KiB são guardas defensivas locais, não prova de streaming HTTP.
- Envelope: `{key,intention}`. Intenção permite somente `instanceID`, `projectID`,
  `operatorID`, `operation`, `target`, `body`, `expectedRevision?`, `confirmationID?`.
  Revisão é inteiro seguro não negativo. Identidade deriva do registro autenticado.
- Registry obrigatório de código confiável resolve operação, capability, método,
  rota exatos, schema de body e tipo do alvo. Alvo tagged `group` tem `groupID`;
  alvo tagged `session` tem `version:1,instanceID,projectID,sessionID`. Fixtures
  registram somente `synthetic.mutate` (confirmação once) e `synthetic.queryOwn`.
  Não existe matriz de operações reais nem autorização default-allow.
- `OperatorAuthorizationPort` obrigatório executa read-own atual antes de buscar
  resultado; novo efeito exige callback separado na mesma transação canônica.
  Capabilities do operador e policy são obrigações de `newEffect(sql, principal,
  intention, capability)`, pela composição confiável com a fonte canônica T11/T12.
  O core não duplica capabilities no schema de credenciais, não recebe mapa de
  autorização de payload/host e não fornece default-allow. A fixture usa
  `synthetic_capabilities` por instalação/operador/projeto/operação/alvo/capability;
  o flag global de deny é somente um negativo adicional, nunca concessão suficiente.
  Grant ausente ou divergente, inclusive capability exigida pelo registry trocada,
  nega sem consumir desafio/confirmação nem escrever efeito/ledger. A matriz e o
  adaptador de autorização de produto permanecem pendentes.
  `expectedRevision` integra schema/hash de intenção no core, mas a comparação com
  a revisão atual do alvo pertence ao hook confiável `newEffect`: a fixture consulta
  `synthetic_target_revisions` na mesma transação. Revisão stale nega; alinhada com
  o alvo admite usando o mesmo desafio ainda não consumido. Não há schema de estado
  de alvos nem semântica de revisão de domínio inventados no core.
  Confirmação vincula hash da intenção sem confirmationID e expiração; ID integra
  intenção final. Nenhum callback pode realizar I/O host. Callback local de fixture
  registra apenas contagem SQL na mesma transação, sem prometer atomicidade host.
- Defaults aprovados para este incremento: TTL 30 s, skew 30 s, quatro desafios
  pendentes/credencial e 128 globais. Knobs só podem apertar esses limites.
  Rate limiting HTTP/token buckets, streaming, headers, stop e cleanup limitado
  foram implementados e testados no [gateway sintético](operator-gateway.md),
  não neste core. O gateway exige dois índices exatos previamente compostos pelo
  dono da persistência, sem auto-migração; a avaliação de índice parcial e as
  limitações de NET/AUD/LIFE estão documentadas lá. Revisão independente do
  gateway e lifecycle real do plugin continuam pendentes. O incremento não
  certifica crescimento indefinido, custo constante ou operação em produção.
- Desafios vinculam credential/revision, projeto, método/rota/operação, audience
  de instalação/boot, timestamp, nonce e hash raw. O core retém desafios consumidos;
  o sweep do gateway pode remover desafios somente após expiração mais 30 s.
  Ledger usa namespace instalação/operador/projeto/key; retenção de resultado de
  pelo menos 30 dias, marcador permanente após expiração. Retry não redispatcha.
- Schema é descriptor sem número global; somente o dono da persistência compõe
  migração. Construtor não abre DB, não migra nem faz enrollment. Registry de
  credenciais guarda o material de autenticação somente como digest, além dos
  metadados de identidade/escopo/revogação; revogação existente não é reescrita ao
  reabrir o core. Isso não testa importação de arquivo de bootstrap real/sintético.
  Gerador é obrigatório e injetado; fixtures usam literais `PUBLIC_TEST_ONLY_`.
  Colisão gerada de `challenge_id` (PK) ou `operation_id` (UNIQUE do ledger)
  retorna `unavailable` e preserva contadores, desafio e confirmação por rollback.
  Após corrigir o gerador, o mesmo desafio pode admitir uma vez. A fixture de
  colisão do ledger escreve uma linha local com ID distinto para provar que a
  falha alcança o UNIQUE do ledger, não o PK do contador sintético.
  Nonce repetido em dois challengeIDs distintos não colapsa identidade de tentativa:
  ambos seguem seus bindings e consumo próprios, recuperando a mesma operação
  idempotente sem novo efeito. Não se inventa UNIQUE de nonce; seleção e qualidade
  do gerador de produto continuam parte do gate anterior a provisionamento.

Teste de dois processos usa a mesma DB canônica T10 e uma barreira stdin: uma
admissão local, um rejeitado e uma linha de efeito. O retorno perdido é recuperado
por desafio novo sem consumir confirmação nem exigir capability de novo efeito.
Erros públicos são códigos constantes, sem body, bearer, header ou PII em logs.
O teste de restart prova somente persistência de revogação/ledger e ausência de
enrollment no core. **AUTH-05 e RET-05 com arquivo de bootstrap continuam pendentes**;
não existe nesta entrega importador de arquivo antigo para exercitar.

**Gate obrigatório:** revisão independente do diff e testes antes de qualquer
endpoint real/provisionamento. Integração real precisa fornecer registry e ports
de autorização confiáveis e provar isolamento lexical, limites de rede e política
de produto. Este incremento não libera T31, emissão ou T29.
