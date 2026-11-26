import { runGuardsCommand } from "../policy/guards-switch.ts";

console.log(runGuardsCommand(process.argv.slice(2).join(" ")));
