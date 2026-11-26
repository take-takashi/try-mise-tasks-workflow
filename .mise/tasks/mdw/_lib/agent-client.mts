import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand, runInteractiveCommand } from "./command.mts";
import { readJson } from "./json.mts";
import { roles } from "./review-data.mts";

function resolveSetting(workflow, role, field, fallback, env) {
	const scope = workflow.toUpperCase();
	field = field.toUpperCase();
	const keys = [];
	if (role) {
		keys.push(`MDW_${scope}_${role.toUpperCase()}_${field}`);
		if (workflow === "review")
			keys.push(`AWF_REVIEW_${role.toUpperCase()}_${field}`);
	}
	keys.push(`MDW_${scope}_${field}`);
	if (workflow === "review") keys.push(`AWF_REVIEW_${field}`);
	keys.push(`MDW_DEFAULT_${field}`);
	for (const key of keys) {
		if (typeof env[key] === "string" && env[key].trim()) return env[key].trim();
	}
	return fallback;
}

export function resolveReviewSetting(role, field, fallback, env = process.env) {
	return resolveSetting("review", role, field, fallback, env);
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
const agyEfforts = ["low", "medium", "high", "xhigh", "max"];
const agyModelEffortPattern = /-(low|medium|high|xhigh|max)$/;
const agyOrchestratorPattern = /orchestrator/i;

function agyModelEffort(model) {
	return typeof model === "string"
		? agyModelEffortPattern.exec(model)?.[1]
		: undefined;
}

function isAgyFixedBudgetModel(model) {
	return typeof model === "string" && agyOrchestratorPattern.test(model);
}

function agyEffortArgs(model, effort) {
	if (
		!model ||
		agyModelEffort(model) ||
		isAgyFixedBudgetModel(model) ||
		!effort
	)
		return [];
	return ["--effort", effort];
}

const agyReadOnlyGitCommands = [
	"command(git diff)",
	"command(git show)",
	"command(git log)",
	"command(git rev-parse)",
];

const agyDeniedGitArgPatterns = [
	"command(regex:^.*--output(?:=|\\s|$).*)",
	"command(regex:^.*--no-index(?:\\s|$).*)",
	"command(regex:^.*--ext-diff(?:\\s|$).*)",
	"command(regex:^.*--textconv(?:\\s|$).*)",
	"command(regex:^.*[;|&`<>].*)",
];

function parseToolNames(tools) {
	return String(tools ?? "")
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

function agyStructuredPrompt(prompt, tools) {
	const allowedTools = parseToolNames(tools);
	if (!allowedTools.includes("Bash")) return prompt;
	return (
		`${prompt}\n\n` +
		"実行環境の制約: シェルコマンドで許可されているのは、単一の git diff / git show / git log / git rev-parse のみです。" +
		"; && || | ` < > によるコマンド連結や、git grep・git status・テスト実行など他のシェルコマンドは使用しないでください。" +
		"ファイルの閲覧やコード検索にはシェルコマンドを使わず、専用のファイル読み取り・検索ツールを使ってください。"
	);
}

function agyReadOnlySettings(tools) {
	const allowedTools = parseToolNames(tools);
	const allowBash = allowedTools.includes("Bash");
	const allowRead = ["Read", "Grep", "Glob"].some((name) =>
		allowedTools.includes(name),
	);
	const deny = [
		"write_file(*)",
		"read_url(*)",
		"execute_url(*)",
		"mcp(*)",
		...(allowBash ? agyDeniedGitArgPatterns : ["command(*)"]),
		...(!allowRead ? ["read_file(*)"] : []),
	];
	return JSON.stringify({
		agentMode: "",
		enableTerminalSandbox: true,
		toolPermission: "request-review",
		permissions: {
			allow: allowBash ? agyReadOnlyGitCommands : [],
			deny,
		},
	});
}

function agyWritableSettings(
	cwd,
	{ allowWritePaths = [], denyWritePaths = [] } = {},
) {
	const writeAllows =
		allowWritePaths.length > 0
			? [...new Set(allowWritePaths)].map(
					(entry) => `write_file(${path.resolve(cwd, entry)})`,
				)
			: [`write_file(${cwd})`];
	const deniedWriteRules = [
		...new Set([".git", ".claude", ".agents", ...denyWritePaths]),
	].map((entry) => `write_file(${path.resolve(cwd, entry)})`);
	return JSON.stringify({
		agentMode: "",
		enableTerminalSandbox: true,
		toolPermission: "request-review",
		permissions: {
			allow: [`read_file(${cwd})`, ...writeAllows],
			deny: [
				"command(*)",
				"read_url(*)",
				"execute_url(*)",
				"mcp(*)",
				...deniedWriteRules,
			],
		},
	});
}

function claudeWritableSettings(denyWritePaths = []) {
	const patterns = [
		...new Set([
			".git/**",
			".claude/**",
			".agents/**",
			"mise*.toml",
			".mise*.toml",
			".env*",
			...denyWritePaths.flatMap((entry) =>
				entry.includes(".") && !entry.startsWith(".")
					? [entry]
					: [`${entry}`, `${entry}/**`],
			),
		]),
	];
	const deny = [
		"Bash(*)",
		...patterns.flatMap((pattern) => [`Edit(${pattern})`, `Write(${pattern})`]),
	];
	return JSON.stringify({ permissions: { deny } });
}

function config(workflow, role, env, cwd) {
	const setting = (field, fallback) =>
		resolveSetting(workflow, role, field, fallback, env);
	const scope = `MDW_${workflow.toUpperCase()}${role ? `_${role.toUpperCase()}` : ""}`;
	const provider = setting("PROVIDER", "codex");
	const model = setting("MODEL", undefined);
	const effort = setting("EFFORT", "medium");
	const billing = setting("BILLING", "subscription");
	const validBilling =
		provider === "agy"
			? ["subscription", "api", "cli"]
			: ["subscription", "api"];
	if (
		!["codex", "claude", "agy"].includes(provider) ||
		!validBilling.includes(billing)
	)
		throw new Error(`${scope}_* の設定が不正です。`);
	if (provider === "codex" && billing !== "subscription")
		throw new Error("CodexのAPI課金はこのPoCでは対応していません。");
	if (provider === "agy" && billing === "api")
		throw new Error("agyのAPI課金はこのPoCでは対応していません。");
	const allowed =
		provider === "codex"
			? ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]
			: provider === "claude"
				? ["low", "medium", "high", "xhigh", "max", "ultracode"]
				: agyEfforts;
	if (!allowed.includes(effort))
		throw new Error(
			`${scope}_EFFORT は ${provider} に対応する値を指定してください。`,
		);
	const resolvedEffort =
		provider === "agy"
			? !model || isAgyFixedBudgetModel(model)
				? null
				: (agyModelEffort(model) ?? effort)
			: effort;
	const resolvedBilling = provider === "agy" ? "cli" : billing;
	return {
		provider,
		model,
		effort: resolvedEffort,
		billing: resolvedBilling,
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
		"GEMINI_API_KEY",
		"GOOGLE_API_KEY",
		"GOOGLE_GENAI_USE_VERTEXAI",
		"AGY_ADC_AUTH",
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
	readonly workflow: string;
	#environment;
	#run;
	#interactive;

	constructor({
		cwd = process.env.MISE_ORIGINAL_CWD || process.cwd(),
		environment = process.env,
		run = runCommand,
		interactive = runInteractiveCommand,
		workflow = "review",
	} = {}) {
		this.cwd = path.resolve(cwd);
		this.#environment = { ...environment };
		this.#run = run;
		this.#interactive = interactive;
		this.workflow = workflow;
	}

	config(role) {
		return config(this.workflow, role, this.#environment, this.cwd);
	}

	async check(
		reviewers = this.workflow === "review" ? Object.keys(roles) : [undefined],
		{ log = console.log } = {},
	) {
		if (!["interview", "issue"].includes(this.workflow))
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
			} else if (provider === "claude") {
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
			} else {
				const result = await this.#run([executable, "models"], {
					env,
					cwd: this.cwd,
					timeout: 30,
				});
				if (!result.stdout.toString("utf8").trim())
					throw new Error(
						"agy の利用可能なモデルを確認できません。agy にログインしているか確認してください。",
					);
				log(
					`${role ?? this.workflow}: agy の設定と利用可能なモデルを確認しました（課金先・アカウントは agy CLI のログイン設定に従います）。`,
				);
				continue;
			}
			log(`${role ?? this.workflow}: ${provider} の設定と認証を確認しました。`);
		}
	}

	interactiveCommand(settings, prompt) {
		const { provider, model, effort, billing, executable } = settings;
		if (provider === "agy") {
			return {
				executable,
				args: [
					...agyEffortArgs(model, effort),
					...(model ? ["--model", model] : []),
					`--prompt-interactive=${prompt}`,
				],
				env: childEnvironment(provider, billing, this.#environment),
			};
		}
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
			executable,
			args: [...args, ...(model ? ["--model", model] : []), prompt],
			env: childEnvironment(provider, billing, this.#environment),
		};
	}

	async runInteractive(settings, prompt) {
		return await this.#interactive(
			this.interactiveCommand(settings, prompt),
			this.cwd,
		);
	}

	async #executeStructured(
		settings,
		prompt,
		schema,
		{
			codexSandbox,
			claudeTools,
			claudePermissionMode,
			claudeExtraArgs = [],
			agySettings,
			agyInput,
		},
	) {
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
						codexSandbox,
						"--ephemeral",
						...(model ? ["--model", model] : []),
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
		} else if (provider === "claude") {
			const result = await this.#run(
				[
					executable,
					"-p",
					...(model ? ["--model", model] : []),
					"--effort",
					effort,
					"--tools",
					claudeTools,
					"--permission-mode",
					claudePermissionMode,
					...claudeExtraArgs,
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
		} else {
			const result = await this.#run(
				[
					executable,
					"--input-format",
					"text",
					"--sandbox",
					"--disable-slash-commands",
					"--settings",
					agySettings,
					"--output-format",
					"json",
					"--json-schema",
					JSON.stringify(schema),
					"--print-timeout",
					`${timeout}s`,
					...agyEffortArgs(model, effort),
					...(model ? ["--model", model] : []),
				],
				{
					cwd: this.cwd,
					env,
					input: agyInput,
					timeout,
				},
			);
			let envelope: {
				status?: string;
				structured_output: ReturnType<typeof readJson>;
				denied_actions?: unknown[];
			};
			try {
				envelope = JSON.parse(result.stdout.toString("utf8"));
			} catch {
				throw new Error("agyの出力が不正なJSONです。");
			}
			if (
				envelope?.status !== "SUCCESS" ||
				!("structured_output" in envelope)
			) {
				if (
					Array.isArray(envelope?.denied_actions) &&
					envelope.denied_actions.length
				)
					throw new Error(
						"agyのツール使用が拒否されたため、構造化出力を取得できませんでした。",
					);
				throw new Error("agyの構造化出力がありません。");
			}
			data = envelope.structured_output;
			permissionDenials = envelope.denied_actions?.length ?? 0;
		}
		return { data, permissionDenials };
	}

	async runStructured(
		settings,
		prompt,
		schema,
		{ tools = "Read,Grep,Glob,Bash" } = {},
	) {
		return await this.#executeStructured(settings, prompt, schema, {
			codexSandbox: "read-only",
			claudeTools: tools,
			claudePermissionMode: "plan",
			agySettings: agyReadOnlySettings(tools),
			agyInput: agyStructuredPrompt(prompt, tools),
		});
	}

	assertWritableProvider(settings, role?: string) {
		if (settings?.provider === "codex") {
			const envKey = `MDW_${this.workflow.toUpperCase()}${role ? `_${role.toUpperCase()}` : ""}_PROVIDER`;
			throw new Error(
				`書き込みを伴う構造化実行ではシェル実行を禁止できないため codex は使用できません。${envKey} に agy または claude を指定してください。`,
			);
		}
	}

	async runWritableStructured(
		settings,
		prompt,
		schema,
		{
			allowWritePaths = [],
			denyWritePaths = [],
			role,
		}: {
			allowWritePaths?: string[];
			denyWritePaths?: string[];
			role?: string;
		} = {},
	) {
		this.assertWritableProvider(settings, role);
		return await this.#executeStructured(settings, prompt, schema, {
			codexSandbox: "workspace-write",
			claudeTools: "Read,Grep,Glob,Edit,Write",
			claudePermissionMode: "acceptEdits",
			claudeExtraArgs: [
				"--setting-sources",
				"",
				"--settings",
				claudeWritableSettings(denyWritePaths),
			],
			agySettings: agyWritableSettings(this.cwd, {
				allowWritePaths,
				denyWritePaths,
			}),
			agyInput: prompt,
		});
	}
}

export async function check(reviewers = Object.keys(roles)) {
	await new AgentClient().check(reviewers);
}
