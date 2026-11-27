import { runGuardsCommand } from "../policy/guards-switch.ts";

console.log(runGuardsCommand("claude", process.argv.slice(2).join(" ")));
