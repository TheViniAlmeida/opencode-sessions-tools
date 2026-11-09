import { createHarness } from "./harness";
import { probeContracts } from "./probes/contracts";
import { runDeliveryProbe } from "./probes/delivery";
import { probeIdentity, probeToolIdentity } from "./probes/identity";
import { runLifecycleProbe } from "./probes/lifecycle";
import {
  probeOperatorChannel,
  probePluginOperatorChannel,
} from "./probes/operator-channel";
import { runPortabilityProbe } from "./probes/portability";
import { runSchedulesProbe } from "./probes/schedules";
import { runUsageProbe } from "./probes/usage";

const scenario = process.argv.slice(2).filter((arg) => arg !== "--")[0];
const additionalProbes: Record<string, () => Promise<unknown>> = {
  delivery: runDeliveryProbe,
  identity: probeIdentity,
  "tool-identity": probeToolIdentity,
  schedules: runSchedulesProbe,
  "operator-channel": async () => ({
    transport: await probeOperatorChannel(),
    plugin: await probePluginOperatorChannel(),
  }),
};
if (scenario && Object.hasOwn(additionalProbes, scenario)) {
  const result = await additionalProbes[scenario]();
  console.log(JSON.stringify({ scenario, result }));
  process.exit(0);
}
if (scenario === "usage") {
  const result = await runUsageProbe();
  console.log(JSON.stringify({ scenario, result }));
  process.exit(0);
}
if (scenario === "lifecycle" || scenario === "portability") {
  const result = await (scenario === "lifecycle"
    ? runLifecycleProbe()
    : runPortabilityProbe());
  console.log(JSON.stringify({ scenario, result }));
  process.exit(0);
}
if (scenario === "contracts") {
  const result = await probeContracts();
  console.log(
    JSON.stringify({
      scenario,
      version: result.server.version,
      servedSHA256: result.served.sha256,
      comparison: result.comparison,
      absent: result.absent,
    }),
  );
  process.exit(0);
}
if (scenario !== "bootstrap") {
  console.error(
    `NOT_IMPLEMENTED: probe ${scenario ?? "<missing>"}; available: bootstrap, contracts, delivery, identity, tool-identity, lifecycle, operator-channel, portability, schedules, usage`,
  );
  process.exit(2);
}
const harness = await createHarness();
try {
  console.log(
    JSON.stringify({
      scenario,
      version: harness.version,
      url: harness.url,
      root: harness.root,
    }),
  );
} finally {
  await harness.stop();
}
