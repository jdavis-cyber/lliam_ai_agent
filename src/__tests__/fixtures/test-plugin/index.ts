import type { PluginModule, PluginAPI } from "../../../plugin/types.js";

const testPlugin: PluginModule = {
  id: "test.basic",
  name: "Test Plugin",
  version: "0.1.0",
  description: "Minimal plugin for unit testing",

  register(api: PluginAPI) {
    api.registerTool({
      name: "test_tool",
      description: "A test tool that returns its input",
      parameters: {
        type: "object" as const,
        properties: {
          value: { type: "string", description: "Value to return" },
        },
        required: ["value"],
      },
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        return { content: `test:${params.value}` };
      },
    });

    api.registerHook("before_agent_start", async (_event) => {
      return { systemPrompt: "Test plugin context" };
    }, { priority: 10 });

    api.registerHook("agent_end", async (_event) => {
      // Fire-and-forget observation
    });

    api.registerCommand({
      name: "test",
      description: "Test command",
      async execute(args: string[]) {
        return `test:${args.join(",")}`;
      },
    });
  },
};

export default testPlugin;
