import type { Plugin } from "@opencode-ai/plugin";
import {
  getAllAgentBodies,
  getAllCommands,
} from "./templates.js";

/**
 * opencode-team plugin entry. Two responsibilities:
 *
 * 1. Register the 6 team/* agents (orchestrator as primary, the rest
 *    as hidden subagents that the orchestrator dispatches to).
 * 2. Register the 5 team/* slash commands.
 *
 * Everything else (model selection, run state, pitfall registry) is
 * handled by the agents themselves via file I/O under
 * .teamwork-runs/. We intentionally do NOT touch the LLM loop — the
 * orchestrator agent owns the run loop in its prompt.
 */
export const TeamPlugin: Plugin = async (_ctx) => {
  const agentBodies = getAllAgentBodies();
  const commands = getAllCommands();

  // The opencode plugin config hook receives the resolved config
  // and a draft object that lets us mutate it. We inject our agents
  // and commands by replacing the `prompt` body to include both the
  // frontmatter (which opencode reads for mode/model/etc) AND the
  // body (which becomes the system prompt).
  return {
    config: async (config: any) => {
      config.agent = config.agent ?? {};
      config.command = config.command ?? {};

      // Inject agents
      for (const [name, body] of Object.entries(agentBodies)) {
        config.agent[`team/${name}`] = { prompt: body };
      }

      // Inject commands
      for (const cmd of commands) {
        config.command[cmd.name] = {
          template: cmd.template,
          description: cmd.description,
          agent: cmd.agent,
        };
      }
    },
  };
};

export default TeamPlugin;

// Named exports for v1 / v2 dual compatibility (mirrors
// oh-my-opencode-slim's exports).
export const id = "opencode-team";
export { TeamPlugin as server };
export { TeamPlugin as setup };
