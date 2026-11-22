import fs from "node:fs";
import { runCommand } from "./command.mts";
import { buildIntentPrompt } from "./intent.mts";

export async function discoverRoot(cwd: string) {
	const { stdout } = await runCommand(["git", "rev-parse", "--show-toplevel"], {
		cwd,
		timeout: 30,
	});
	return stdout.toString("utf8").trim();
}

export function buildPrompt() {
	const interview = fs.readFileSync(
		new URL("../prompts/interview.md", import.meta.url),
		"utf8",
	);
	return `${interview.trimEnd()}\n\n${buildIntentPrompt()}`;
}
