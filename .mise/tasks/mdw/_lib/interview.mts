import fs from "node:fs";
import { buildIntentPrompt } from "./intent.mts";
import { discoverRoot } from "./interactive.mts";

export { discoverRoot };

export function buildPrompt() {
	const interview = fs.readFileSync(
		new URL("../prompts/interview.md", import.meta.url),
		"utf8",
	);
	return `${interview.trimEnd()}\n\n${buildIntentPrompt()}`;
}
