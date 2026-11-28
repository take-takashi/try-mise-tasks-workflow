import { runCommand } from "./command.mts";

export async function discoverRoot(
	cwd: string,
	{ env = process.env }: { env?: NodeJS.ProcessEnv } = {},
) {
	const { stdout } = await runCommand(["git", "rev-parse", "--show-toplevel"], {
		cwd,
		env,
		timeout: 30,
	});
	return stdout.toString("utf8").trim();
}
