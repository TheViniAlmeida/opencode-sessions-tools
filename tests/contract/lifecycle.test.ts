import { beforeAll, describe, expect, test } from "bun:test";
import { runLifecycleProbe } from "../../scripts/probes/lifecycle";

describe("T5 native lifecycle, synthetic isolated host", () => {
  let evidence: Awaited<ReturnType<typeof runLifecycleProbe>>;
  beforeAll(async () => {
    evidence = await runLifecycleProbe();
  }, 120_000);

  test("native create preserves parentID and explicit location", () => {
    expect(evidence.baseline).toBe("opencode v2.2.5");
    expect(evidence.serverVersion).toBe("2.2.5");
    expect(evidence.create.child.parentID).toBe(evidence.create.parent.id);
    expect(evidence.create.child.location).toEqual(
      evidence.create.parent.location,
    );
    expect(evidence.create.parent.location.directory).toMatch(
      /^\/tmp\/opencode\/opencode-sessions-tools\/fixture-[^/]+\/project$/,
    );
    expect(evidence.create.independent.parentID).toBeUndefined();
  });

  test("fork has distinct ID, lineage and copied synthetic history", () => {
    expect(evidence.fork.status).toBe(200);
    expect(evidence.fork.info.id).not.toBe(evidence.fork.sourceID);
    expect(evidence.fork.info.fork?.sessionID).toBe(evidence.fork.sourceID);
    expect(evidence.fork.messages.data).toContainEqual(
      expect.objectContaining({
        type: "synthetic",
        text: "T5 synthetic transcript",
      }),
    );
  });

  test("rename/archive/restore are observed after 204 acknowledgements", () => {
    expect(evidence.rename).toEqual({
      status: 204,
      observed: "T5 synthetic renamed",
    });
    expect(evidence.archive.status).toBe(204);
    expect(evidence.archive.observed).toBeGreaterThan(0);
    expect(evidence.archive.messages.data).toContainEqual(
      expect.objectContaining({ text: "T5 synthetic transcript" }),
    );
    expect(evidence.restore).toEqual({ status: 204, observed: null });
  });

  test("configuration and interrupt acknowledgements do not prove future execution", () => {
    expect(evidence.configuration.agentSelection?.status).toBe(204);
    expect(evidence.configuration.selectedAgent).toBe("build");
    expect(evidence.configuration.invalidModelStatus).toBe(400);
    expect(evidence.configuration.futureExecutionSelectionProven).toBe(false);
    expect(evidence.interrupt.status).toBe(200);
  });

  test("compact admission is not successful completion", () => {
    expect(evidence.compact.admission.status).toBe(200);
    expect(evidence.compact.admission.data.type).toBe("compaction");
    expect(evidence.compact.successfulCompletionProven).toBe(false);
    expect(evidence.compact.observedCompletion).toBe("failed");
    expect(evidence.compact.messages.status).toBe(200);
  });

  test("NO-GO: native cascade deletes a child outside the validated set", () => {
    const deletion = evidence.deletion;
    expect(deletion.nativeRequestBody).toBeNull();
    expect(deletion.nativeParameters).toEqual([
      { name: "sessionID", in: "path" },
    ]);
    expect(deletion.preview).toHaveLength(2);
    expect(deletion.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(deletion.trace).toEqual([
      "preview",
      "validated",
      "external-child-created",
      "delete-called",
    ]);
    expect(deletion.extraBeforeStatus).toBe(200);
    expect(deletion.extraParentID).toBe(evidence.create.parent.id);
    expect(deletion.preview).not.toContain(deletion.extraID);
    expect(deletion.deleteStatus).toBe(204);
    expect(deletion.after.map((item) => item.status)).toEqual([404, 404, 404]);
    expect(deletion.unapprovedExtraDeleted).toBe(true);
    expect(evidence.verdict).toBe("NO-GO");
    expect(evidence.blockedRequirements).toEqual(["LIF-09", "LIF-10"]);
    expect(evidence.productDeleteEnabled).toBe(false);
  });

  test("external references become dangling; unrelated synthetic root survives", () => {
    expect(evidence.references.externalReference.target).toBe(
      evidence.create.parent.id,
    );
    expect(evidence.references.independentAfterStatus).toBe(200);
    expect(evidence.references.forkAfterStatus).toBe(200);
    expect(evidence.references.forkSourceDeleteStatus).toBe(204);
    expect(evidence.references.targetMissing).toBe(true);
    expect(evidence.references.pluginCleanupProven).toBe(false);
  });
});
