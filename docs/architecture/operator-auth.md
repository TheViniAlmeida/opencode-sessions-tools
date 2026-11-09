# Autenticação de operador — AD-009, 07/11/2026

Status: docs AD-008/009 APROVADAS na rodada posterior de 07/11/2026;
viabilidade T3-P0/P0 aprovada em rev-p0-fechamento e T9 liberada por ordem
explícita. Implementação/auth/provisionamento de produto exigem T3-PROD e
revisão de armazenamento/provisionamento. Nenhum segredo foi criado. API
continua obrigatória na 1.0 (API-01/09/11); fechar superfície insegura não autoriza
retirá-la da entrega nem certificar auth de produto.
Rodada posterior de 07/11/2026: documentação AD-008/009 e probe SES-01
APROVADOS. Isso não aprova P0, T3 completo nem autenticação de produto.
AD-007 permanece APROVADA; não autoriza emissão de segredo. A ordem posterior
liberou T9 após viabilidade P0 e ajustou DAG, mantendo T3-PROD obrigatório.

## Identidade e canal

Credencial própria de operador é separada das sessões, grants e credencial de
transporte do servidor. Autenticação do RPC nativo autentica acesso ao servidor,
não prova operador nem autoria de sessão. IDs, texto de comando, role e flags no
payload não promovem principal. Contexto de execução de tool comprovado na fixture
do host 2.2.5 para SES-01; claims recebidos no input são ignorados, não promovem
a operador. Essa prova não valida comando humano, always,
provisionamento ou autenticação de produto. Operador deve permanecer
fail-closed até prova do canal e revisão de provisionamento.

Não passar segredo em payload de tools/RPC: logs e transcripts podem capturá-lo.
Não guardar em config visível ao modelo, resposta RPC ou contexto do agente.
Não pressupor `ctx` HTTP ou headers customizados no handler RPC. As evidências de
SDK/host em T2/T3 devem mostrar um canal seguro antes de escolher integração.

Arquitetura preferida mínima: gateway HTTP criado no setup do plugin, no mesmo
processo, recebe header Authorization e chama callback lexical privado do núcleo,
nunca RPC administrativo ou proxy de tool. Listener pertence ao runtime, não a
uma API administrativa HTTP do SDK. Evidência real e limites estão em
[identity.md](../compatibility/identity.md): fixture prova listener em setup,
callback sintético, fechamento por restart/stop e unload isolado do pacote com
cleanup do listener no host 2.2.5. Literal pública e igualdade mock NÃO provam segurança de produto,
autenticação, anti-replay ou execução real de tool.

Gateway separado com envelope assinado verificado pelo núcleo é apenas
alternativa se houver necessidade comprovada; assinatura deve vincular nonce,
body/hash, operação, instância/audience e prazo, com replay store atômico. Não
presumir bridge autenticada existente nem criar broker adicional sem revisão.

Gates obrigatórios antes de adotar/provisionar:
- Bind exclusivo em `127.0.0.1`, porta allowlisted e não exposta por RPC/tool do
  produto; validar instância e callback inacessível por RPC/tool.
- Validar Host/Origin com política explícita, sem CORS permissivo; loopback não é
  autenticação. Limitar corpo em streaming ANTES de alocar corpo completo, além
  de timeout e rate limit. O mock atual não atende ao limite de alocação.
- Anti-replay vincula nonce de uso único, body/hash exato, operação, instância e
  prazo; consumo atômico rejeita repetição, alteração e concorrência. Provar o
  mecanismo escolhido, sem chamar mera validação de JSON de anti-replay.
- Cleanup no unload/restart, falha de setup e stop; restart/stop têm evidência
  sintética no host 2.2.5, incluindo unload isolado do pacote e cleanup do listener,
  conforme [identity.md](../compatibility/identity.md). Não deixar listener órfão.

## Verificação e autorização

- Token aleatório de alta entropia, emitido SOMENTE por provisionamento humano
  posterior aprovado. Guardar verificador digest, não token em texto no DB.
- Comparar digest de tamanho fixo em tempo constante; erro genérico para token
  inválido, expirado ou revogado, sem material secreto em detalhes.
- Registro associa identificador não secreto, digest, capabilities explícitas,
  escopo de instalação/projeto e revisão/revogação. Autenticar não concede tudo:
  cada operação usa a autorização comum e seus limites atuais.
- Reavaliar revogação antes de novas admissões; não prometer desfazer efeito já
  enviado. Cache não pode perpetuar acesso revogado. Rotação revoga registro antigo
  após consumidores revisados; testes negativos provam o comportamento.
- Redigir header, token e digest em logs, tracing, erros, respostas e auditoria;
  registrar somente identificador não secreto e decisão. Limitar tentativas e
  exposição de rede; não registrar corpo/header bruto na borda.

## Armazenamento e provisionamento a revisar

Preferir armazenamento protegido pelo SO ou arquivo fora do repo/config do agente,
diretório 0700 e arquivo 0600, proprietário dedicado quando possível. Gateway
verifica digest; cliente humano mantém segredo em armazenamento de credenciais do
SO ou arquivo restrito. Broker separado só se necessário para evitar acesso pelo
runtime do agente; escolha, ownership, backup, recuperação e revogação pendentes
de revisão antes da emissão. Não usar argumentos de linha de comando ou exemplos
com token real. Provisionamento não devolve segredo por RPC/modelo.

Shell irrestrito sob o mesmo usuário pode ler arquivos, memória ou chamar serviços:
está explicitamente fora da garantia de isolamento. Permissões 0600 não isolam
processos do mesmo UID. Isolamento contra esse adversário exigiria identidade de
SO/broker e política próprios, não uma promessa do plugin.

## Incremento T3-PROD — decisão de protocolo proposta, 08/11/2026

Status: **design APROVADO após correção de retry equality; core sintético em implementação**.
Não autoriza provisionamento, segredo operacional, porta fixa ou autenticação de produção.
Este DESIGN/TEST PLAN não aprova implementação nem GO de produção.
A ordem atual autoriza projetar credencial própria do operador por projeto e
revisar antes de provisionar; não autoriza emitir segredo, abrir listener
persistente, alterar config/env/allowlist ou instalar dependências. Fundação
T9–T13 deve estar aprovada antes da implementação; o integrador confere os
aceites. O gate normativo continua sendo o de
[tasks.md](../../.specs/features/session-orchestration/tasks.md#subgate-normativo-t3-prod--produto-autenticação-e-provisionamento).
Modelo de ameaça e plano de testes:
[operator-threat-model.md](operator-threat-model.md).

### Bearer com desafio vinculado, não HMAC com digest

Escolha mínima proposta: autenticar cada requisição com bearer de alta entropia
no header `Authorization`; armazenar somente digest SHA-256 do token aleatório
de pelo menos 256 bits gerado por CSPRNG. Comparar digests de tamanho fixo em
tempo constante. Não implementar comparação própria nem tratar hash de senha
humana como equivalente a token aleatório. Identificador público seleciona o
registro; credencial inexistente segue caminho de comparação com digest dummy,
sem prometer tempo total indistinguível entre todos os caminhos.

**Não há assinatura de requisição nesta escolha.** O digest armazenado não é
chave capaz de verificar HMAC produzido com o token original. Usar esse digest
como chave criaria outra credencial reutilizável, não resolveria o problema.
HMAC exigiria armazenamento protegido de chave verificadora secreta e outro
desenho aprovado; gateway separado assinado permanece alternativa, não fallback.

O bearer autentica; um desafio emitido pelo servidor vincula e torna consumível
uma tentativa de transporte. A identidade da intenção não é a identidade dessa
tentativa. Contrato revisado e aprovado para implementação/testes sintéticos:

**Intenção canônica imutável**:
`{instanceID, projectID, operatorID, operation, target, body, expectedRevision?, confirmationID?}`.
`instanceID` é identidade persistente da instalação; `operatorID` é identidade
estável do operador, resolvida pelo registro autenticado, preservada na rotação
e nunca promovida por payload. `confirmationID`, quando fornecido, integra a
intenção: retry preserva o mesmo ID, ainda que consumido/expirado; omitir,
substituir ou acrescentar esse campo muda o hash. A aprovação referencia o hash
dos demais campos de intenção (sem o próprio confirmationID, evitando ciclo);
o ledger final inclui também o ID e vincula essa aprovação à admissão.

Normalização de negócio é determinística e versionada por contrato: rejeitar
campos desconhecidos, chaves JSON duplicadas, números não finitos e tipos
inválidos; resolver defaults previstos pelo schema; não aparar strings nem
normalizar Unicode implicitamente. Serializar recursivamente objetos com chaves
ordenadas, arrays na ordem original e escalares JSON em representação única.
O hash SHA-256 é dos bytes UTF-8 dessa intenção normalizada, não de headers,
nonce ou envelope de autenticação. Mesmo business body normalizado significa
mesmo hash independentemente da ordem das chaves/whitespace no transporte.
Formatos numéricos e schemas precisam de fixtures de equivalência aprovadas antes
de código; não admitir representação ambígua como igualdade por conveniência.

**Namespace idempotente**: `(instanceID, operatorID, projectID, key)`, sem
`operation` e sem credential ID. Mesma chave nesse namespace com operação,
target, body, revisão ou confirmationID diferente retorna conflito. Outro
projeto é outro namespace, nunca recupera a admissão anterior: sem escopo atual,
nega; com escopo, pode constituir intenção nova e exige toda autorização nova.

**Tentativa de transporte**:
`{credentialID, challengeID, nonce, issuedAt, expiresAt, audience, requestBodyHash}`.
Esses campos não integram o hash da intenção; `requestBodyHash` autentica a
vinculação do desafio aos bytes exatos do corpo HTTP dessa tentativa, incluindo
o envelope de intenção/chave, sem headers de autenticação. Mudar representação
do corpo exige novo desafio, mas não muda intenção de negócio equivalente.
Audience contém instanceID esperado e epoch de boot do runtime; validar ambos
em cada tentativa. Restart muda epoch, não instanceID/namespace idempotente.

Protocolo, com formatos e limites ainda sujeitos ao gate do revisor:

1. Cliente humano prepara bytes UTF-8 definitivos do corpo e calcula SHA-256.
   Solicita desafio autenticado para método, rota/operação conhecida, digest do
   corpo, escopo de projeto/instalação e audience da instância. Não enviar segredo
   no JSON. Timestamp do cliente é validado contra relógio do servidor.
2. Gateway verifica credencial vigente e escopo, gera nonce aleatório de 256 bits
   e persiste desafio pendente com credential ID/revision, método, rota, operação,
   body hash, projeto, audience, timestamp e expiração do servidor. O próprio
   registro é a vinculação confiável; campos repetidos no pedido não a substituem.
3. Cliente envia operação com bearer novamente, nonce e os mesmos bindings.
   Gateway limita streaming, calcula hash dos bytes exatos antes de parsear,
   valida timestamp/prazo, audience e correspondência com registro. Não
   reserializar JSON para calcular hash nem aceitar alias de rota/operação.
4. Transação canônica revalida credencial atual, não revogada/expirada, revision,
   operatorID e autorização atual para ler a própria operação/admissão nesse
   escopo. Consulta o namespace/chave **antes** de exigir capabilities de novo
   efeito ou confirmação fresca. Existindo registro, hash diferente conflita;
   hash igual retorna ID original e resultado atual. Consome somente o desafio
   fresco desta tentativa para proteger o transporte; não consome confirmação
   once outra vez, não exige aprovação antiga ainda válida, nova permissão de
   manage nem enfileira/envia novamente. `unknown_outcome` permanece desconhecido
   até reconciliação independente; replay não o promove a sucesso.
5. Ausente registro, exige capabilities atuais de efeito, policy/denies e
   confirmação humana fresca quando aplicável. Consumo condicional do desafio,
   consumo once da confirmação e inserção de ledger/admissão são uma única
   transação na mesma DB. Uniqueness do namespace/chave faz um concorrente vencer;
   perdedor reavalia ramo de recuperação, sem executar efeito. Rollback não deixa
   efeito externo anterior ao commit. Efeito host só ocorre após admissão.
6. Ledger e resultado têm retenção mínima de **30 dias**, conforme spec; não
   expiram com nonce ou confirmação. Expiração é estado explícito: reter marcador
   durável de namespace/chave e hash; retornar expiração sem nova admissão nem
   redispatch, mesmo após remoção do resultado completo. Nova intenção exige nova
   chave e rito normal. Timeout pós-commit permite novo desafio e mesma intenção,
   nunca retry cego de efeito. Não prometer exactly-once para API nativa.

Credencial revogada é negada também ao recuperar resultado; a admissão original
fica intacta. Credencial nova explicitamente vinculada ao mesmo operatorID pode
recuperar a própria admissão com escopo/permissão de leitura atuais aprovados,
sem repetir autorização de novo efeito. Não transferir propriedade por rotação.

Proteção contra replay significa impedir reutilização de desafio/admissão, não
impedir que quem roubou o bearer obtenha desafios novos. Um observador que captura
requisição completa pode tentar vencer uma corrida; HTTP loopback não fornece
confidencialidade contra adversário local privilegiado. Ameaça que inclua esse
adversário exige outro isolamento/transporte revisado antes do provisionamento.

Timestamp e TTL não substituem nonce persistido. Audience não é Host fornecido
pelo chamador; restart troca seu epoch e invalida desafios anteriores, mantendo
instanceID persistente. Banco indisponível, relógio fora da
janela ou falha criptográfica: negar admissão. Não há fallback em memória.

### Borda, principal e limites propostos

- Bind somente `127.0.0.1`, **porta fixa allowlisted ainda não escolhida**.
  Configurar porta, allowlist e env gerenciado exige confirmação explícita futura.
  Conflito de bind falha fechado, sem porta aleatória ou bind externo alternativo.
- Host deve ser exatamente o par IP/porta configurado. Rejeitar qualquer Origin,
  inclusive `null`; não oferecer cliente browser/CORS. Rejeitar preflight,
  redirects, proxy headers como autoridade, métodos e rotas não registrados.
- Proposta para revisão: headers até 8 KiB; corpo até 64 KiB em streaming;
  duração total de leitura 5 s, inatividade 2 s; até 8 leituras e 4 admissões
  simultâneas; bucket global de 60 pedidos/minuto com burst 10 e bucket por
  credential ID de 20/minuto com burst 4. IDs desconhecidos não criam buckets
  ilimitados: estrutura limitada a 128 entradas, além do limite global.
- Proposta: desafio TTL 30 s, desvio de timestamp até 30 s, até 4 desafios
  pendentes por credencial e 128 globais. Limpeza é limitada por lote, sem apagar
  registro ainda válido para reabrir capacidade. Tombstones de nonce consumido
  duram pelo menos até expiração mais janela; idempotência segue retenção própria,
  nunca é apagada junto com nonce para permitir duplicação.
- Esses números são orçamento de desenho, não valores aprovados nem medidos no
  host. SDK/runtime pode alocar chunk antes da aplicação; provar limite da leitura
  da aplicação não prova limite total de memória. Prazo HTTP não cancela efeito já
  admitido. Lifecycle fecha conexões e impede novas admissões no unload/stop.
- Gateway constrói principal autenticado em closure privada e entrega ao núcleo
  por entrada lexical não exportada. DTO não contém role/capabilities confiáveis;
  tools, commands e RPC não conseguem selecionar essa entrada. Não serializar
  principal para depois aceitá-lo de input. Código arbitrário in-process não é
  adversário isolado por essa closure.
- Cada nova admissão verifica capabilities e projeto exatos, denies e limites comuns;
  recuperação verifica autorização atual de leitura própria conforme ramo acima.
  Confirmação humana é registro separado vinculado a principal, operação, alvo,
  hash de negócio sem confirmationID, revisão e prazo; bearer/nonce não são confirmação. Repetição
  idempotente não renova aprovação nem autoriza alvo alterado. Always ou mudança
  de policy/model/config não ganha autoaprovação por autenticar operador.

### Bootstrap e ciclo de credencial propostos

Ferramenta humana fora do canal do modelo gera segredo no runtime e grava arquivo
externo ao repo/config/transcript, diretório 0700 e arquivo 0600. Não imprime token,
digest, header nem conteúdo do arquivo; não recebe segredo por argv/env/RPC. O
cliente humano lê esse arquivo; bootstrap do gateway no mesmo processo lê o arquivo
restrito e deriva digest para verificar o registro persistente, sem persistir token
no banco. Registry persistente é autoridade: startup **não cria, reativa nem
atualiza** registro por encontrar arquivo. Token antigo em arquivo nunca ressuscita
credencial revogada; registro ausente/revogado/divergente falha fechado. Somente
enrollment/rotação explicitamente humanos criam novo auth record e vínculo operatorID.
Path/ownership e proteção de backup/recuperação precisam de aprovação antes de
criação. Validar proprietário/permissões e recusar symlink/path inesperado; falhar
sem expor valor. Minimizar vida do buffer não é promessa de zeroização do runtime.

**0600 não protege do shell do mesmo UID.** O bootstrap não torna o arquivo
inacessível ao modelo com shell irrestrito. Se isso fizer parte da ameaça aceita,
esta proposta in-process é insuficiente e deve parar para desenho de identidade
SO/broker próprio. Não reutilizar credencial nativa do host.

Registro é escopado a instalação/projeto, com ID público, digest, capabilities,
revision, expiração e revogação. Toda nova admissão reconsulta estado transacional;
revogar invalida desafios pendentes sem cancelar efeito já enviado. Rotação humana
cria novo registro/arquivo após inventário de consumidores e verificação da escrita,
testa consumidor e revoga o anterior; janela de sobreposição precisa ser aprovada,
nunca indefinida. Recuperação emite outra credencial por rito humano, não exporta
token antigo pelo gateway. Auditoria limitada a ID público, operação enumerada,
decisão e correlação não secreta; sem body, header, token, digest ou nonce bruto.
Erros de autenticação são genéricos para ausente/inválido/expirado/revogado;
exceções internas e dumps de request nunca atravessam a borda.

## Gate T3-PROD e revisão de produto

Provar assinatura/contexto reais do SDK e canal escolhido; testar token ausente,
inválido, revogado, escopo insuficiente, payload forjado e credencial de sessão
tentando virar operador. Inspecionar logs/transcripts para ausência de segredo;
provar que header não vira payload RPC. Revisar armazenamento/provisionamento e
modelo de ameaça antes de implementar auth ou pedir emissão humana posterior.
Revisor independente valida essas evidências e os requisitos API; falha bloqueia
a entrega, não reduz silenciosamente a 1.0.
