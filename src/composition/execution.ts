import { DomainError } from "../contracts";
import {
  Dispatcher,
  type PromptHostPort,
  type TrustedChainPort,
} from "../messaging/dispatcher";
import {
  Replies,
  type ReplyTimerPort,
  type ReplyWakePort,
} from "../messaging/replies";
import {
  canonicalUsageEvents,
  type RunnerUsageSource,
  type UsageAccessPort,
  UsageService,
} from "../observability/usage";
import {
  type QuestionOperatorPort,
  type QuestionPolicyPort,
  questionsRunnerPort,
  Requests,
} from "../orchestration/requests";
import {
  Runner,
  type RunnerCancellationPort,
  type RunnerPromptPolicyPort,
  runnerAdmissionEvidence,
  runnerOutcomeEvidence,
  type TaskOutcomePort,
} from "../orchestration/runner";
import { Tasks } from "../orchestration/tasks";
import { Scheduler, type SchedulerOptions } from "../schedules/service";
import { removedTargetPort } from "../sessions/reconcile";
import type { CompositionRuntime } from "./runtime";
import {
  assertComposedServices,
  type createComposedServices,
} from "./services";

type LocalServices = ReturnType<typeof createComposedServices>;

/** Internal trusted dependencies. Missing host/policy adapters are integration
 * gaps, not permission to install permissive production defaults. */
export interface ComposedExecutionOptions {
  readonly runtime: CompositionRuntime;
  /** Must be the local graph created with this exact runtime. */
  readonly services: LocalServices;
  readonly clock: () => number;
  readonly chain: TrustedChainPort;
  readonly promptHost: PromptHostPort;
  readonly outcomes: TaskOutcomePort;
  readonly promptPolicy: RunnerPromptPolicyPort;
  readonly cancellation: RunnerCancellationPort;
  readonly questionOperator: QuestionOperatorPort;
  readonly questionPolicy: QuestionPolicyPort;
  readonly usageAccess: UsageAccessPort;
  readonly usageSource: RunnerUsageSource;
  readonly replyWakes: ReplyWakePort;
  readonly replyTimers: ReplyTimerPort;
  readonly scheduler: Pick<
    SchedulerOptions,
    "clock" | "coordinator" | "limits"
  > & {
    readonly outcomes: NonNullable<SchedulerOptions["outcomes"]>;
  };
}

/** No timer/listener starts here. The caller owns runtime and local services.
 * Reconciliation cleanup and Groups.activeWork must already be assembled by
 * their owner; this factory does not patch those services or their SQL. */
export function createComposedExecution(options: ComposedExecutionOptions) {
  if (
    !options?.runtime ||
    !options.services ||
    typeof options.clock !== "function" ||
    !options.chain ||
    !options.promptHost ||
    !options.outcomes ||
    !options.promptPolicy ||
    !options.cancellation ||
    !options.questionOperator ||
    !options.questionPolicy ||
    !options.usageAccess ||
    !options.usageSource ||
    !options.replyWakes ||
    !options.replyTimers ||
    !options.scheduler ||
    !options.scheduler.clock ||
    !options.scheduler.coordinator ||
    !options.scheduler.limits ||
    !options.scheduler.outcomes
  )
    throw new DomainError("unavailable");
  const requiredMethods = [
    options.chain.current,
    options.promptHost.send,
    options.promptHost.inspect,
    options.outcomes.inspect,
    options.promptPolicy.snapshot,
    options.cancellation.deliver,
    options.cancellation.inspect,
    options.questionOperator.current,
    options.questionPolicy.snapshot,
    options.usageAccess.check,
    options.usageSource.estimateReservation,
    options.usageSource.snapshot,
    options.replyWakes.subscribe,
    options.replyWakes.publish,
    options.replyTimers.schedule,
    options.scheduler.clock.utc,
    options.scheduler.clock.monotonic,
    options.scheduler.clock.setTimer,
    options.scheduler.coordinator.now,
    options.scheduler.limits.assert,
    options.scheduler.outcomes.inspect,
  ];
  if (requiredMethods.some((method) => typeof method !== "function"))
    throw new DomainError("unavailable");
  const { runtime, services, clock } = options;
  assertComposedServices(runtime, services);
  const storage = runtime.persistence;
  const { identity, policy, authorizer } = services;
  const dispatcher = new Dispatcher(
    storage,
    identity,
    authorizer,
    options.chain,
    options.promptHost,
    clock,
    removedTargetPort,
  );
  const requests = new Requests(
    storage,
    identity,
    options.questionOperator,
    options.questionPolicy,
    clock,
  );
  const usage = new UsageService(
    storage,
    identity,
    options.usageAccess,
    canonicalUsageEvents(storage, {
      appendInTx(sql, event, actor) {
        services.events.appendInTransaction(sql, event, actor);
      },
    }),
  );
  const tasks = new Tasks(storage, identity, policy, clock, {
    admissions: runnerAdmissionEvidence,
    outcomes: runnerOutcomeEvidence,
  });
  const runner = new Runner(
    tasks,
    dispatcher,
    options.outcomes,
    options.promptPolicy,
    usage.runnerAdapter(options.usageSource),
    questionsRunnerPort(requests),
    options.cancellation,
    clock,
  );
  const replies = new Replies(
    storage,
    identity,
    authorizer,
    removedTargetPort,
    options.replyWakes,
    clock,
    options.replyTimers,
  );
  const scheduler = new Scheduler({
    storage,
    identity,
    policy,
    grants: services.grants,
    ...options.scheduler,
    targets: removedTargetPort,
    dispatcher(owner, authorization) {
      // Scheduler supplies the persisted owner and its fenced authorization.
      // Never mutate the invocation identity or replace the shared policy.
      return new Dispatcher(
        storage,
        { current: async () => owner },
        authorization,
        options.chain,
        options.promptHost,
        clock,
        removedTargetPort,
      );
    },
  });
  let disposed = false;
  let ticking: Promise<
    ReadonlyArray<{ phase: string; error: unknown }>
  > | null = null;
  return {
    dispatcher,
    runner,
    tasks,
    requests,
    scheduler,
    usage,
    replies,
    /** Explicit maintenance only; errors isolate phases and remain observable.
     * Timer-driven orchestration belongs to a later lifecycle supervisor. */
    tick(): Promise<ReadonlyArray<{ phase: string; error: unknown }>> {
      if (disposed) return Promise.reject(new DomainError("unavailable"));
      if (ticking) return ticking;
      ticking = (async () => {
        const failures: { phase: string; error: unknown }[] = [];
        const phases: readonly [string, () => unknown][] = [
          ["dispatcher.expirePending", () => dispatcher.expirePending()],
          ["operations.recover", () => services.operations.recover()],
          ["requests.expire", () => requests.expire()],
          ["events.prune", () => services.events.prune()],
          ["memory.prune", () => services.sharedMemory.prune()],
          ["scheduler.tick", () => scheduler.tick()],
        ];
        for (const [phase, run] of phases) {
          if (disposed) break;
          try {
            await run();
          } catch (error) {
            failures.push({ phase, error });
          }
        }
        return failures;
      })().finally(() => {
        ticking = null;
      });
      return ticking;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      scheduler.dispose();
    },
  };
}
