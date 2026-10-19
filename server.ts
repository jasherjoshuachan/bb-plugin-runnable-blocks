// Runnable Blocks — backend.
//
// Declares the plugin's settings and one RPC method, `shellIntegration`,
// which writes the shell integration files into the plugin's data folder and
// tells the frontend how to start an integrated "Run blocks" terminal on
// this machine. It makes no network calls, runs no commands except reading
// the account's login shell (`dscl` on macOS) and stores nothing else.
// Terminals are driven from the frontend through bb's own SDK.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { dirname, join } from "node:path";
import { prepareIntegration, type IntegrationInfo } from "./lib/integration-files.ts";
import { schema, stringSchema } from "./lib/schema.ts";
import { DEFAULT_LANGUAGES, validateLanguages, validateRiskyPatterns } from "./lib/settings.ts";

function isIntegrationInfo(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return "Expected an object.";
  const v = value as Record<string, unknown>;
  if (v.available === true) {
    return (v.shell === "zsh" || v.shell === "bash") &&
      typeof v.shellPath === "string" &&
      Array.isArray(v.argv) &&
      v.argv.every((item) => typeof item === "string")
      ? null
      : "Malformed integration info.";
  }
  return v.available === false && typeof v.reason === "string" && (v.shell === null || typeof v.shell === "string")
    ? null
    : "Malformed integration info.";
}

export const rpcContract = defineRpcContract({
  shellIntegration: {
    experimental_description:
      "How to start a shell with Runnable Blocks' OSC 133 integration on the bb server's machine.",
    input: schema<null>((value) => (value === null || value === undefined ? null : "Takes no input.")),
    output: schema<IntegrationInfo>(isIntegrationInfo),
  },
});

export default async function plugin(bb: BbPluginApi) {
  bb.settings.define({
    languages: {
      type: "string",
      label: "Languages",
      description: `Code block languages that get the toolbar, comma-separated. Any of: ${DEFAULT_LANGUAGES.replace(/,/g, ", ")}.`,
      experimental_schema: stringSchema(validateLanguages),
      default: DEFAULT_LANGUAGES,
    },
    confirmMode: {
      type: "select",
      label: "Confirm before running",
      description: "Multi-line and risky commands always ask, whatever this says.",
      options: ["first-run", "every-run"],
      experimental_optionLabels: {
        "first-run": "First run in each thread",
        "every-run": "Every run",
      },
      default: "first-run",
    },
    terminalMode: {
      type: "select",
      label: "Run uses",
      description: "Reuse the thread's idle “Run blocks” terminal, or open a new one for every Run.",
      options: ["reuse", "new"],
      experimental_optionLabels: { reuse: "The thread's “Run blocks” terminal", new: "A new terminal each time" },
      default: "reuse",
    },
    extraRiskyPatterns: {
      type: "string",
      label: "Extra risky patterns",
      description:
        "Regular expressions, comma-separated (write a literal comma as \\,). A command that matches one needs “Run anyway”.",
      experimental_schema: stringSchema(validateRiskyPatterns),
      default: "",
    },
    showOutputPreview: {
      type: "boolean",
      label: "Show output preview",
      description: "Show the last 20 lines of a run's output under its block.",
      default: true,
    },
    shellIntegration: {
      type: "boolean",
      label: "Shell integration",
      description:
        "Start “Run blocks” terminals with zsh or bash prompt marks (OSC 133) so each run shows its exit status. Your commands are never changed.",
      default: true,
    },
  });

  // <dataDir>/plugins/<id>/data.db -> <dataDir>/plugins/<id>/shell-integration
  const integrationRoot = (): string => join(dirname(bb.storage.database().name), "shell-integration");

  bb.rpc.register(rpcContract, {
    async shellIntegration() {
      try {
        return await prepareIntegration(integrationRoot());
      } catch (cause) {
        bb.log.warn(`shell integration unavailable: ${cause instanceof Error ? cause.message : String(cause)}`);
        return { available: false as const, shell: null, reason: "Couldn't write the shell integration files." };
      }
    },
  });
}
