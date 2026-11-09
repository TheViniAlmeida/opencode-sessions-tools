# Matriz de rastreabilidade

Status dos 82 itens ativos: **Pending**; LIF-08/09/10: **Deferred** por AD-007.
85 IDs históricos preservados. Mapeamento planejado, não cobertura executada.
Testes seguem a pasta indicada pela matriz do plano; os nomes abaixo são cenários
propostos. T36 verifica os 82 ativos independentemente, não os três deferred.

| ID | Tarefa responsável | Cenário obrigatório |
| --- | --- | --- |
| SES-01 | T14, T31 | identity_from_host_not_payload |
| SES-02 | T14 | same_project_minimal_metadata |
| SES-03 | T14 | cross_project_non_disclosure |
| SES-04 | T14 | pagination_100_and_cursor |
| SES-05 | T15 | membership_never_grants_access |
| SES-06 | T14 | cyclic_links_tree_deduplicated |
| ACL-01 | T12 | directional_operator_grant |
| ACL-02 | T11, T12 | agent_cannot_issue_grant |
| ACL-03 | T11 | current_policy_checked_before_effect |
| ACL-04 | T12, T20 | revoke_pending_before_admission |
| ACL-05 | T12, T20 | revoke_after_admission_reports_boundary |
| ACL-06 | T11, T17 | execution_policy_operator_and_denies |
| ACL-07 | T11, T32 | forged_rpc_session_rejected |
| ACL-08 | T12 | pending_access_request_has_no_grant |
| ACL-09 | T12, T33 | resolve_or_expire_access_request_24h |
| ACL-10 | T11, T17 | tightened_policy_applies_to_existing_children |
| ACL-11 | T11, T25 | self_model_and_always_require_operator |
| MSG-01 | T19 | persist_envelope_before_dispatch |
| MSG-02 | T19 | notification_does_not_start_model |
| MSG-03 | T20 | request_creates_task_and_queue_admission |
| MSG-04 | T21 | correlated_authorized_reply |
| MSG-05 | T13, T20 | same_key_same_id_no_duplicate |
| MSG-06 | T13, T20 | timeout_after_acceptance_is_unknown |
| MSG-07 | T20 | fifo_queue_per_target |
| MSG-08 | T20 | ninth_automatic_hop_rejected |
| MSG-09 | T19 | utf8_payload_65536_vs_65537 |
| MSG-10 | T21 | wait_30s_returns_pending_cursor |
| LIF-01 | T16 | native_child_and_explicit_delegation |
| LIF-02 | T16 | cross_project_root_plus_grant |
| LIF-03 | T17 | rename_returns_observed_title |
| LIF-04 | T17 | model_agent_style_next_execution_only |
| LIF-05 | T17 | interrupt_request_not_terminal_proof |
| LIF-06 | T17, T29 | archived_target_suspends_jobs |
| LIF-07 | T17 | compact_vs_reset_new_successor |
| LIF-08 | Deferred — AD-007; sem tarefa 1.0 | Histórico: deletion_preview_tree_digest_token (não obrigatório 1.0) |
| LIF-09 | Deferred — AD-007; sem tarefa 1.0 | Histórico: changed_tree_or_60s_expiry_rejected (não obrigatório 1.0) |
| LIF-10 | Deferred — AD-007; sem tarefa 1.0 | Histórico: exact_set_delete_and_payload_cleanup (não obrigatório 1.0) |
| LIF-11 | T16 | fork_history_without_grants_jobs_approvals |
| LIF-12 | T11, T17 | profile_persists_effective_intersection |
| LIF-13 | T11, T16 | child_cannot_exceed_creator_capabilities |
| TSK-01 | T23 | task_objective_executor_expected_result |
| TSK-02 | T23 | dependency_cycle_rejected |
| TSK-03 | T24 | ready_task_admitted_once |
| TSK-04 | T24 | fifth_concurrent_or_depth_excess_pending |
| TSK-05 | T24 | final_result_not_idle_completes_task |
| TSK-06 | T23 | failed_dependency_blocks_join |
| TSK-07 | T24 | active_cancel_waits_for_confirmation |
| TSK-08 | T25 | question_expected_principal_only |
| TSK-09 | T25 | agent_reply_not_human_approval |
| CTX-01 | T26 | selected_export_version_origin_hash |
| CTX-02 | T27 | create_native_whole_batch_new_session_or_append_plugin_attachment_explicit_tool_requires_context.read_AND_read_current_principal_owner_target_no_native_history_write_no_host_execution_no_grants (domínio AD-010 APROVADO 43/328; root v23 15/77; native adapter 6/28 aprovado, refinamento autor 10/47 aguarda follow-up independente; native-real/E2E/full PENDING) |
| CTX-03 | T27 | invalid_hash_version_size_no_effect |
| CTX-04 | T26 | native_transcript_loss_disclosure |
| CTX-05 | T28 | concurrent_memory_compare_and_swap |
| CTX-06 | T28 | expiry_read_block_and_60s_tombstone |
| CTX-07 | T27 | partial_import_records_known_ids |
| CTX-08 | T27 | partial_import_retry_returns_original |
| SCH-01 | T29 | exactly_one_schedule_kind_and_iana_zone |
| SCH-02 | T29 | anchored_300s_interval_no_drift |
| SCH-03 | T29 | overlapping_run_coalesces_once |
| SCH-04 | T29 | restart_records_misses_and_one_catchup |
| SCH-05 | T29 | local_admission_rechecks_grant_revision_target_expiry_count |
| SCH-06 | T10, T29 | two_workers_one_local_db_fenced_admission_no_host_fence |
| SCH-07 | T29 | pause_blocks_future_not_past_effects |
| SCH-08 | T29 | offline_no_dispatch_then_recovery |
| SCH-09 | T29 | dst_gap_skip_fold_first_occurrence |
| SCH-10 | T29 | shell_and_code_conditions_unsupported |
| API-01 | T31, T32 | tool_rpc_equivalent_domain_result |
| API-02 | T22 | durable_authorized_cursor_replay |
| API-03 | T22 | cursor_older_than_30d_expired |
| API-04 | T30 | overlapping_group_usage_dedup |
| API-05 | T30 | absent_usage_is_null_not_zero |
| API-06 | T30 | reported_vs_estimated_active_vs_elapsed |
| API-07 | T30 | budget_blocks_new_admission_only |
| API-08 | T31, T32 | typed_redacted_errors_and_retryability |
| API-09 | T32, T34 | runnable_http_typescript_and_complete_reference |
| API-10 | T2, T9, T31 | absent_capability_not_certified |
| API-11 | T3, T11, T32 | unauthenticated_external_api_fail_closed |
| API-12 | T33 | every_normative_command_arguments_principal_output |
| API-13 | T30 | operator_budget_revision_and_event |
| REL-01 | T10, T13 | db_failure_prevents_host_mutation |
| REL-02 | T13, T22 | reload_reconcile_no_duplicate_listener |
| REL-03 | T14, T18 | externally_deleted_target_rejected |
| REL-04 | T18 | external_delete_tombstone_cleans_plugin_payload_without_host_delete |
| REL-05 | T9, T23 | invalid_transition_conflict_preserves_state |

## Critérios adicionais de release

- T34: licença final aprovada; docs e exemplos coerentes com a versão.
- T35: instalação do tarball, upgrade e recuperação em ambiente limpo.
- T36: aceite sintético, revisão independente e evidência por critério.

Provas T3–T8 não substituem os testes dos serviços: são evidência de viabilidade.
Na implementação, acrescentar caminho e nome de teste efetivos, resultado, versão
e commit a cada linha antes de mudar Pending para Verified.

## Gate de viabilidade e gate de produto — atualização de 07/11/2026

T3 nas linhas da matriz identifica T3-P0 para viabilidade e seu subgate normativo
T3-PROD para implementação/aceite de produto; o primeiro não satisfaz o segundo.
SES-01, ACL-02/06/07/11, API-11/12 mantêm mapping e critérios ativos completos.
P0 APROVADO pelo revisor no lote rev-p0-fechamento (45 contract/401 assertions);
T9 iniciada por ordem explícita. T3-PROD depende T9–T13, bloqueia T31/T32/T33 e
emissão de segredo; auth/provisionamento não aprovados. Plano mantém 36 tarefas
principais, 82 edges Tn e oito edges do subgate (90 totais), sem ciclo. Não há
nova execução de testes nesta atualização. 85 IDs históricos/82 ativos intactos.
