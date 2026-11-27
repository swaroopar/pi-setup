import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runGuardsCommand } from "../policy/guards-switch.ts";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("guards", {
		description: "Turn the agent guards (require-skills, no-comments) on or off in pi: /guards on | off",
		handler: async (args, ctx) => ctx.ui.notify(runGuardsCommand("pi", args), "info"),
	});
}
