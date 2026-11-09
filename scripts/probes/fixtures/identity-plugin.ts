import { writeFile } from "node:fs/promises";
import { Plugin } from "@opencode/plugin";
import { Rpc } from "@opencode/plugin/rpc";
import { createOperatorChannelFixture } from "./operator-channel";

/** Diagnostic fixture only. Never grants permissions or accepts an operator claim. */
const Identity = Rpc.define({
  id: "identity-candidate",
  events: {},
  methods: {
    gateway: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: {
        type: "object",
        properties: {
          callbackCount: { type: "integer" },
          transportOnly: { type: "boolean" },
        },
        required: ["callbackCount", "transportOnly"],
        additionalProperties: false,
      },
    },
    current: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          principal: { type: "string" },
        },
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          operator: { type: "boolean" },
          contextKeys: { type: "array", items: { type: "string" } },
        },
        required: ["operator", "contextKeys"],
        additionalProperties: false,
      },
    },
  },
});

export default Plugin.define({
  id: "identity-private-fixture",
  async setup(ctx) {
    const home = process.env.HOME;
    if (
      !home?.startsWith("/tmp/opencode/opencode-sessions-tools/fixture-") ||
      !home.endsWith("/home")
    )
      throw new Error("Identity fixture requires isolated HOME");
    const gateway = createOperatorChannelFixture();
    const descriptor = `${home}/identity-channel.json`;
    const publish = (state: string) =>
      writeFile(
        descriptor,
        JSON.stringify({
          port: Number(new URL(gateway.url).port),
          pid: process.pid,
          state,
        }),
        { mode: 0o600 },
      );
    let toolRegistration: { dispose(): Promise<void> } | undefined;
    try {
      await publish("active");
      toolRegistration = await ctx.tool.transform((editor) => {
        for (const strict of [false, true]) {
          editor.add({
            name: strict ? "identity_diagnostic_strict" : "identity_diagnostic",
            options: { codemode: false },
            description:
              "Synthetic identity fixture; no administrative actions.",
            input: {
              type: "object",
              properties: strict
                ? { action: { type: "string", enum: ["diagnostic"] } }
                : {
                    action: { type: "string", enum: ["diagnostic"] },
                    caller_sessionID: { type: "string" },
                    principal: { type: "string" },
                  },
              required: ["action"],
              additionalProperties: false,
            },
            async execute(input, context) {
              const value = input as Record<string, unknown>;
              if (value.action !== "diagnostic")
                throw new Error("Identity diagnostic input denied");
              return {
                content: JSON.stringify({
                  fixture: "identity-tool",
                  sessionID: context.sessionID,
                  agent: context.agent,
                  callID: context.id,
                  receivedKeys: Object.keys(value).sort(),
                }),
              };
            },
          });
        }
      });
      const registration = await ctx.rpc.register(Identity, {
        gateway: async () => ({
          callbackCount: gateway.calls(),
          transportOnly: true,
        }),
        current: async (_input, context) => ({
          operator: false,
          contextKeys: Object.keys(context).sort(),
        }),
      });
      return async () => {
        gateway.stop();
        await publish("unloaded");
        return Promise.all([
          registration.dispose(),
          toolRegistration?.dispose(),
        ]).then(() => {});
      };
    } catch (error) {
      gateway.stop();
      await toolRegistration?.dispose();
      throw error;
    }
  },
});
