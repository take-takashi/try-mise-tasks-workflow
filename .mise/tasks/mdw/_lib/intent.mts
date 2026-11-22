import fs from "node:fs";

export function buildIntentPrompt() {
	return fs.readFileSync(
		new URL("../prompts/intent.md", import.meta.url),
		"utf8",
	);
}
