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

export function requireInteractiveTerminal() {
	if (!process.stdin.isTTY || !process.stdout.isTTY)
		throw new Error(
			"対話には端末が必要です。プロンプトを取得する場合は --prompt を指定してください。",
		);
}

export function runInteractiveCommand({ executable, args, env }, cwd: string) {
	requireInteractiveTerminal();
	return new Promise<number>((resolve, reject) => {
		const child = spawn(executable, args, {
			cwd,
			env,
			stdio: "inherit",
			shell: false,
		});
		// 親だけに届いた中断も CLI に伝え、終了を待って終了コードを返す。
		const interrupt = () => child.kill("SIGINT");
		const terminate = () => child.kill("SIGTERM");
		process.on("SIGINT", interrupt);
		process.on("SIGTERM", terminate);
		const cleanup = () => {
			process.off("SIGINT", interrupt);
			process.off("SIGTERM", terminate);
		};
		child.once("error", (error) => {
			cleanup();
			reject(new Error(`${executable} CLI を起動できません: ${error.message}`));
		});
		child.once("exit", (code, signal) => {
			cleanup();
			resolve(code ?? (signal === "SIGINT" ? 130 : 143));
		});
	});
}
