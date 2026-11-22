import { spawn } from "node:child_process";
import path from "node:path";

export function runCommand(
	command,
	{
		env = process.env,
		input = "",
		timeout = 600,
		cwd = path.resolve(process.env.MISE_ORIGINAL_CWD || process.cwd()),
	} = {},
) {
	return new Promise((resolve, reject) => {
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(command[0], command.slice(1), {
				cwd,
				env,
				shell: false,
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch (error) {
			reject(new Error(command[0] + " の実行に失敗しました: " + error.name));
			return;
		}
		const stdout = [],
			stderr = [];
		let timedOut = false,
			finished = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeout * 1000);
		child.stdout.on("data", (chunk) => stdout.push(chunk));
		child.stderr.on("data", (chunk) => stderr.push(chunk));
		child.stdin.on("error", () => {});
		child.on("error", (error) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			reject(new Error(command[0] + " の実行に失敗しました: " + error.name));
		});
		child.on("close", (code, signal) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			if (timedOut) {
				reject(new Error(command[0] + " の実行がタイムアウトしました。"));
				return;
			}
			if (code !== 0) {
				reject(
					new Error(
						command[0] +
							" が終了コード " +
							(code ?? signal) +
							" で失敗しました。CLIの認証、モデル、設定を確認してください。",
					),
				);
				return;
			}
			resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
		});
		child.stdin.end(input);
	});
}
