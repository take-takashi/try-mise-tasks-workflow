import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand } from "./command.mts";
import { readJson } from "./json.mts";
import { roles } from "./review-data.mts";

export function resolveReviewSetting(role, field, fallback, env = process.env) {
	role = role.toUpperCase();
	field = field.toUpperCase();
	for (const key of [
		"MDW_REVIEW_" + role + "_" + field,
		"AWF_REVIEW_" + role + "_" + field,
		"MDW_REVIEW_" + field,
		"MDW_DEFAULT_" + field,
	]) {
		if (typeof env[key] === "string" && env[key].trim()) return env[key];
	}
	return fallback;
}
function executableOnPath(name, env, cwd) {
	for (const dir of (env.PATH || "").split(path.delimiter)) {
		const file = path.resolve(cwd, dir || ".", name);
		try {
			fs.accessSync(file, fs.constants.X_OK);
			if (fs.statSync(file).isFile()) return file;
		} catch {}
	}
	throw new Error(name + " CLI が見つかりません。");
}
function config(role, env, cwd) {
	const provider = resolveReviewSetting(role, "PROVIDER", "codex", env);
	const model = resolveReviewSetting(role, "MODEL", "gpt-6.1-sol", env);
	const effort = resolveReviewSetting(role, "EFFORT", "medium", env);
	const billing = resolveReviewSetting(role, "BILLING", "subscription", env);
	if (
		!["codex", "claude"].includes(provider) ||
		!model ||
		!["subscription", "api"].includes(billing)
	)
		throw new Error(
			"MDW_REVIEW_" + role.toUpperCase() + "_* の設定が不正です。",
		);
	if (provider === "codex" && billing !== "subscription")
		throw new Error("CodexのAPI課金はこのPoCでは対応していません。");
	const allowed =
		provider === "codex"
			? ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]
			: ["low", "medium", "high", "xhigh", "max", "ultracode"];
	if (!allowed.includes(effort))
		throw new Error(
			"MDW_REVIEW_" +
				role.toUpperCase() +
				"_EFFORT は " +
				provider +
				" に対応する値を指定してください。",
		);
	return {
		provider,
		model,
		effort,
		billing,
		executable: executableOnPath(provider, env, cwd),
	};
}
export function childEnvironment(provider, billing, environment = process.env) {
	const env = { ...environment };
	const apiKey = env.MDW_ANTHROPIC_API_KEY || env.AWF_ANTHROPIC_API_KEY || "";
	for (const key of [
		"MDW_ANTHROPIC_API_KEY",
		"AWF_ANTHROPIC_API_KEY",
		"REVIEW_ANTHROPIC_API_KEY",
		"OPENAI_API_KEY",
		"CODEX_API_KEY",
		"ANTHROPIC_API_KEY",
		"ANTHROPIC_AUTH_TOKEN",
		"ANTHROPIC_BASE_URL",
		"CLAUDE_CODE_USE_BEDROCK",
		"CLAUDE_CODE_USE_VERTEX",
		"CLAUDE_CODE_USE_FOUNDRY",
		"CLAUDE_CODE_USE_GATEWAY",
	])
		delete env[key];
	if (provider === "claude" && billing === "api") {
		if (!apiKey)
			throw new Error("Claude APIには MDW_ANTHROPIC_API_KEY が必要です。");
		env.ANTHROPIC_API_KEY = apiKey;
	}
	return env;
}
export function timeoutSeconds(env = process.env) {
	const raw =
		env.MDW_REVIEW_TIMEOUT_SECONDS ?? env.AWF_REVIEW_TIMEOUT_SECONDS ?? "600";
	if (
		!/^\s*\+?\d+\s*$/.test(raw) ||
		!Number.isSafeInteger(Number(raw)) ||
		Number(raw) < 1
	)
		throw new Error(
			"MDW_REVIEW_TIMEOUT_SECONDS は正の整数を指定してください。",
		);
	return Number(raw);
}
// 一つの実行環境を保持し、認証確認と AI CLI の呼び出しに同じ設定を使う。
export class AgentClient {
	readonly cwd: string;
	#environment;
	#run;

	constructor({
		cwd = process.env.MISE_ORIGINAL_CWD || process.cwd(),
		environment = process.env,
		run = runCommand,
	} = {}) {
		this.cwd = path.resolve(cwd);
		this.#environment = { ...environment };
		this.#run = run;
	}

	config(role) {
		return config(role, this.#environment, this.cwd);
	}

	async check(reviewers = Object.keys(roles)) {
		timeoutSeconds(this.#environment);
		for (const role of reviewers) {
			const { provider, billing, executable } = this.config(role);
			const env = childEnvironment(provider, billing, this.#environment);
			if (provider === "codex") {
				const result = await this.#run([executable, "login", "status"], {
					env,
					cwd: this.cwd,
					timeout: 30,
				});
				if (
					!(result.stdout.toString() + result.stderr.toString()).includes(
						"Logged in using ChatGPT",
					)
				)
					throw new Error("CodexのChatGPT認証を確認できません。");
			} else {
				const result = await this.#run([executable, "auth", "status"], {
					env,
					cwd: this.cwd,
					timeout: 30,
				});
				let status: { authMethod?: string };
				try {
					status = JSON.parse(result.stdout.toString("utf8"));
				} catch {
					throw new Error("Claudeの認証状態を読み取れません。");
				}
				if (
					status?.authMethod !== (billing === "api" ? "api_key" : "claude.ai")
				)
					throw new Error(
						"Claudeの認証方式が指定した " + billing + " と一致しません。",
					);
			}
			console.log(role + ": " + provider + " の設定と認証を確認しました。");
		}
	}

	async runStructured(settings, prompt, schema) {
		const { provider, model, effort, billing, executable } = settings;
		const env = childEnvironment(provider, billing, this.#environment);
		const timeout = timeoutSeconds(this.#environment);
		let data: ReturnType<typeof readJson>;
		let permissionDenials = 0;
		if (provider === "codex") {
			const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "mdw-review-"));
			try {
				const schemaFile = path.join(temporary, "schema.json"),
					resultFile = path.join(temporary, "response.json");
				fs.writeFileSync(schemaFile, JSON.stringify(schema), "utf8");
				await this.#run(
					[
						executable,
						"exec",
						"--ignore-user-config",
						"-c",
						'model_provider="openai"',
						"-c",
						"model_reasoning_effort=" + JSON.stringify(effort),
						"--sandbox",
						"read-only",
						"--ephemeral",
						"--model",
						model,
						"--output-schema",
						schemaFile,
						"-o",
						resultFile,
						"-",
					],
					{ cwd: this.cwd, env, input: prompt, timeout },
				);
				data = readJson(resultFile);
			} finally {
				fs.rmSync(temporary, { recursive: true, force: true });
			}
		} else {
			const result = await this.#run(
				[
					executable,
					"-p",
					"--model",
					model,
					"--effort",
					effort,
					"--tools",
					"Read,Grep,Glob,Bash",
					"--permission-mode",
					"plan",
					"--strict-mcp-config",
					"--no-chrome",
					"--no-session-persistence",
					"--output-format",
					"json",
					"--json-schema",
					JSON.stringify(schema),
				],
				{ cwd: this.cwd, env, input: prompt, timeout },
			);
			let envelope: {
				is_error?: boolean;
				structured_output: ReturnType<typeof readJson>;
				permission_denials?: unknown[];
			};
			try {
				envelope = JSON.parse(result.stdout.toString("utf8"));
			} catch {
				throw new Error("Claudeの出力が不正なJSONです。");
			}
			if (!envelope || envelope.is_error || !("structured_output" in envelope))
				throw new Error("Claudeの構造化出力がありません。");
			data = envelope.structured_output;
			permissionDenials = envelope.permission_denials?.length ?? 0;
		}
		return { data, permissionDenials };
	}
}

export async function check(reviewers = Object.keys(roles)) {
	await new AgentClient().check(reviewers);
}
