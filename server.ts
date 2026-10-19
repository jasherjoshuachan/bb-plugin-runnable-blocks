// Runnable Blocks — backend.
//
// `bb plugin build` requires a server entry. This one only declares the
// plugin's setting; it makes no network calls, runs no commands and stores
// nothing. Terminals are driven from the frontend through bb's own SDK.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export default async function plugin(bb: BbPluginApi) {
  bb.settings.define({
    confirmEveryRun: {
      type: "boolean",
      label: "Confirm every run",
      description:
        "Ask before every Run, not only the first one in a thread. Multi-line and risky commands always ask.",
      default: false,
    },
  });
}
