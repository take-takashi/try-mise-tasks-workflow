import { runCommand } from "./command.mts";

export async function discoverRoot(cwd: string) {
	const { stdout } = await runCommand(["git", "rev-parse", "--show-toplevel"], {
		cwd,
		timeout: 30,
	});
	return stdout.toString("utf8").trim();
}
