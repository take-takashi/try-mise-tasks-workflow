import { spawn } from "node:child_process";
import fs from "node:fs";
import { childEnvironment } from "./agent-client.mts";
import { runCommand } from "./command.mts";

export async function discoverRoot(cwd: string) {
	const { stdout } = await runCommand(["git", "rev-parse", "--show-toplevel"], {
		cwd,
		timeout: 30,
	});
	return stdout.toString("utf8").trim();
}

export function buildPrompt() {
	return fs.readFileSync(
		new URL("../prompts/interview.md", import.meta.url),
		"utf8",
	);
}

export function interviewCommand(prompt: string, environment = process.env) {
	const setting = (field: string, fallback: string) =>
		environment[`MDW_INTERVIEW_${field}`]?.trim() ||
		environment[`MDW_DEFAULT_${field}`]?.trim() ||
		fallback;
	const provider = setting("PROVIDER", "codex");
	const model = setting(
		"MODEL",
		provider === "codex" ? "gpt-6.1-sol" : "sonnet",
	);
	const effort = setting("EFFORT", "medium");
	const billing = setting("BILLING", "subscription");
	if (
		!["codex", "claude"].includes(provider) ||
		!["subscription", "api"].includes(billing) ||
		(provider === "codex" && billing !== "subscription")
	)
		throw new Error("MDW_INTERVIEW_* のプロバイダーまたは課金方式が不正です。");
	const efforts =
		provider === "codex"
			? ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]
			: ["low", "medium", "high", "xhigh", "max", "ultracode"];
	if (!efforts.includes(effort))
		throw new Error("MDW_INTERVIEW_EFFORT がプロバイダーに対応していません。");
	const args =
		provider === "codex"
			? [
					"--sandbox",
					"workspace-write",
					"--ask-for-approval",
					"on-request",
					"-c",
					`model_reasoning_effort=${JSON.stringify(effort)}`,
				]
			: ["--effort", effort];
	return {
		provider,
		args: [...args, "--model", model, prompt],
		env: childEnvironment(provider, billing, environment),
	};
}

export function runInteractive({ provider, args, env }, cwd: string) {
	if (!process.stdin.isTTY || !process.stdout.isTTY)
		throw new Error(
			"対話には端末が必要です。プロンプトを取得する場合は --prompt を指定してください。",
		);
	return new Promise<number>((resolve, reject) => {
		const child = spawn(provider, args, {
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
			reject(new Error(`${provider} CLI を起動できません: ${error.message}`));
		});
		child.once("exit", (code, signal) => {
			cleanup();
			resolve(code ?? (signal === "SIGINT" ? 130 : 143));
		});
	});
}
