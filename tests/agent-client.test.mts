import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentClient } from "../.mise/tasks/mdw/_lib/agent-client.mts";

function executables(t) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "mdw-agent-config-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	for (const provider of ["codex", "claude", "agy"])
		fs.writeFileSync(path.join(root, provider), "", { mode: 0o755 });
	return root;
}

test("各ワークフローの設定を優先し、共通の検証で不正値を拒否する", (t) => {
	const root = executables(t);
	for (const workflow of ["review", "interview", "issue", "worktree"]) {
		const prefix = `MDW_${workflow.toUpperCase()}`;
		const env = {
			PATH: root,
			MDW_DEFAULT_PROVIDER: "codex",
			MDW_DEFAULT_MODEL: "default-model",
			MDW_DEFAULT_EFFORT: "low",
			MDW_REVIEW_MODEL: "review-only",
			[`${prefix}_PROVIDER`]: "claude",
			[`${prefix}_MODEL`]: "workflow-model",
			[`${prefix}_EFFORT`]: "high",
			[`${prefix}_BILLING`]: "api",
		};
		const config = (environment) =>
			new AgentClient({ cwd: root, workflow, environment }).config();
		assert.deepEqual(config(env), {
			provider: "claude",
			model: "workflow-model",
			effort: "high",
			billing: "api",
			executable: path.join(root, "claude"),
		});
		for (const [field, value] of [
			["PROVIDER", "unknown"],
			["BILLING", "unknown"],
			["EFFORT", "unknown"],
		])
			assert.throws(() => config({ ...env, [`${prefix}_${field}`]: value }));
		assert.throws(
			() => config({ ...env, [`${prefix}_PROVIDER`]: "codex" }),
			/API課金/,
		);
		assert.throws(
			() => config({ ...env, PATH: path.join(root, "missing") }),
			/CLI が見つかりません/,
		);
	}
});

test("各ワークフローは指定した課金方式と異なる認証を拒否する", async (t) => {
	const root = executables(t);
	for (const workflow of ["review", "interview", "issue", "worktree"]) {
		for (const provider of ["codex", "claude", "agy"]) {
			const client = new AgentClient({
				cwd: root,
				workflow,
				environment: {
					PATH: root,
					MDW_DEFAULT_PROVIDER: provider,
					MDW_DEFAULT_BILLING: "subscription",
				},
				run: async () => ({
					stdout: Buffer.from(
						provider === "codex"
							? "Logged in using an API key"
							: provider === "claude"
								? JSON.stringify({ authMethod: "api_key" })
								: "",
					),
					stderr: Buffer.alloc(0),
				}),
			});
			await assert.rejects(
				client.check(),
				provider === "agy" ? /利用可能なモデル/ : /認証/,
			);
		}
	}
});

test("対話もクライアント作成時の環境と検証済みの実行ファイルを使う", async (t) => {
	const root = executables(t);
	const environment = {
		PATH: root,
		MDW_INTERVIEW_PROVIDER: "codex",
		MDW_INTERVIEW_MODEL: "original-model",
		MDW_INTERVIEW_EFFORT: "medium",
		OPENAI_API_KEY: "unrelated-key",
	};
	const calls = [];
	const client = new AgentClient({
		cwd: root,
		workflow: "interview",
		environment,
		interactive: async (command, cwd) => {
			calls.push({ command, cwd });
			return 7;
		},
	});
	environment.PATH = "";
	environment.MDW_INTERVIEW_MODEL = "changed-model";
	assert.equal(await client.runInteractive(client.config(), "prompt"), 7);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].cwd, root);
	assert.equal(calls[0].command.executable, path.join(root, "codex"));
	assert.equal(calls[0].command.env.OPENAI_API_KEY, undefined);
	assert.equal(calls[0].command.env.PATH, root);
	const args = calls[0].command.args;
	assert.equal(args[args.indexOf("--model") + 1], "original-model");
	assert.equal(args.at(-1), "prompt");
});

test("モデル未指定または空白のみのときは --model を渡さず各 CLI の既定モデルに委ねる", async (t) => {
	const root = executables(t);
	for (const provider of ["codex", "claude", "agy"]) {
		for (const rawModel of [undefined, "   "]) {
			const calls = [];
			const environment = {
				PATH: root,
				MDW_DEFAULT_PROVIDER: provider,
				...(rawModel !== undefined ? { MDW_DEFAULT_MODEL: rawModel } : {}),
			};
			const client = new AgentClient({
				cwd: root,
				workflow: "review",
				environment,
				run: async (args) => {
					calls.push(args);
					if (provider === "codex") {
						fs.writeFileSync(
							args[args.indexOf("-o") + 1],
							JSON.stringify({ ok: true }),
						);
						return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
					}
					if (provider === "agy") {
						return {
							stdout: Buffer.from(
								JSON.stringify({
									status: "SUCCESS",
									structured_output: { ok: true },
								}),
							),
							stderr: Buffer.alloc(0),
						};
					}
					return {
						stdout: Buffer.from(
							JSON.stringify({
								structured_output: { ok: true },
								permission_denials: [],
							}),
						),
						stderr: Buffer.alloc(0),
					};
				},
			});
			const settings = client.config();
			assert.equal(settings.model, undefined);
			const interactive = client.interactiveCommand(settings, "prompt");
			assert.ok(!interactive.args.includes("--model"));
			assert.equal(
				interactive.args.at(-1),
				provider === "agy" ? "--prompt-interactive=prompt" : "prompt",
			);
			const structured = await client.runStructured(settings, "prompt", {
				type: "object",
			});
			assert.deepEqual(structured, {
				data: { ok: true },
				permissionDenials: 0,
			});
			assert.equal(calls.length, 1);
			assert.ok(!calls[0].includes("--model"));
		}
	}
});

test("agy の設定検証、エフォート・課金扱い、環境分離、stdin と構造化出力を検証する", async (t) => {
	const root = executables(t);
	const logs = [];
	const calls = [];
	const client = new AgentClient({
		cwd: root,
		workflow: "review",
		environment: {
			PATH: root,
			MDW_DEFAULT_PROVIDER: "agy",
			MDW_DEFAULT_EFFORT: "medium",
			MDW_REVIEW_SECURITY_MODEL: "gemini-3.8-flash-low",
			MDW_REVIEW_QUALITY_MODEL: "gemini-pro-orchestrator-neon",
			MDW_REVIEW_QUALITY_EFFORT: "high",
			MDW_REVIEW_TIMEOUT_SECONDS: "45",
			GEMINI_API_KEY: "secret-gemini-key",
			GOOGLE_API_KEY: "secret-google-key",
			GOOGLE_GENAI_USE_VERTEXAI: "true",
			AGY_ADC_AUTH: "true",
			OPENAI_API_KEY: "secret-openai-key",
		},
		run: async (args, options) => {
			calls.push({ args, options });
			if (args[1] === "models")
				return {
					stdout: Buffer.from("gemini-3.8-flash-low  Gemini 3.8 Flash (Low)\n"),
					stderr: Buffer.alloc(0),
				};
			return {
				stdout: Buffer.from(
					JSON.stringify({
						status: "SUCCESS",
						structured_output: { ok: true },
						denied_actions: [{ action: "write_file", display_name: "Write" }],
					}),
				),
				stderr: Buffer.alloc(0),
			};
		},
	});

	await client.check(["security"], { log: (message) => logs.push(message) });
	assert.match(logs[0], /agy CLI のログイン設定に従います/);

	const security = client.config("security");
	assert.equal(security.model, "gemini-3.8-flash-low");
	assert.equal(security.effort, "low");
	assert.equal(security.billing, "cli");
	const securityInteractive = client.interactiveCommand(security, "-prompt");
	assert.ok(!securityInteractive.args.includes("--effort"));
	assert.deepEqual(securityInteractive.args, [
		"--model",
		"gemini-3.8-flash-low",
		"--prompt-interactive=-prompt",
	]);
	assert.equal(securityInteractive.env.GEMINI_API_KEY, undefined);
	assert.equal(securityInteractive.env.GOOGLE_API_KEY, undefined);
	assert.equal(securityInteractive.env.GOOGLE_GENAI_USE_VERTEXAI, undefined);
	assert.equal(securityInteractive.env.AGY_ADC_AUTH, undefined);
	assert.equal(securityInteractive.env.OPENAI_API_KEY, undefined);

	const quality = client.config("quality");
	assert.equal(quality.model, "gemini-pro-orchestrator-neon");
	assert.equal(quality.effort, null);
	assert.equal(quality.billing, "cli");
	const orchestratorInteractive = client.interactiveCommand(quality, "prompt");
	assert.ok(!orchestratorInteractive.args.includes("--effort"));

	const longPrompt = "A".repeat(200_000);
	const structured = await client.runStructured(
		quality,
		longPrompt,
		{ type: "object" },
		{ tools: "Read,Grep,Glob,Bash" },
	);
	assert.deepEqual(structured, { data: { ok: true }, permissionDenials: 1 });
	const structuredCall = calls.at(-1);
	assert.ok(structuredCall.args.includes("--input-format"));
	assert.equal(
		structuredCall.args[structuredCall.args.indexOf("--input-format") + 1],
		"text",
	);
	assert.ok(structuredCall.args.includes("--sandbox"));
	assert.ok(structuredCall.args.includes("--disable-slash-commands"));
	assert.ok(!structuredCall.args.includes("--effort"));
	assert.ok(!structuredCall.args.some((arg) => arg.includes(longPrompt)));
	assert.ok(structuredCall.options.input.startsWith(`${longPrompt}\n\n`));
	assert.match(structuredCall.options.input, /単一の git diff/);
	assert.equal(
		structuredCall.args[structuredCall.args.indexOf("--print-timeout") + 1],
		"45s",
	);
	assert.equal(
		structuredCall.args[structuredCall.args.indexOf("--model") + 1],
		"gemini-pro-orchestrator-neon",
	);
	const settings = JSON.parse(
		structuredCall.args[structuredCall.args.indexOf("--settings") + 1],
	);
	assert.equal(settings.agentMode, "");
	assert.equal(settings.enableTerminalSandbox, true);
	assert.equal(settings.toolPermission, "request-review");
	assert.ok(settings.permissions.allow.includes("command(git diff)"));
	assert.ok(settings.permissions.allow.includes("command(git show)"));
	assert.ok(!settings.permissions.allow.includes("command(git grep)"));
	assert.ok(!settings.permissions.allow.includes("command(git status)"));
	assert.ok(settings.permissions.deny.includes("write_file(*)"));
	const outputDeny = settings.permissions.deny.find((rule) =>
		rule.includes("--output"),
	);
	assert.ok(outputDeny);
	const outputRegex = new RegExp(outputDeny.slice("command(regex:".length, -1));
	assert.ok(outputRegex.test("git diff --output=/tmp/evil HEAD"));
	assert.ok(!outputRegex.test("git diff --no-ext-diff HEAD"));
	assert.ok(!settings.permissions.deny.includes("command(*)"));
	assert.ok(!settings.permissions.deny.includes("read_file(*)"));
	assert.equal(structuredCall.options.env.GEMINI_API_KEY, undefined);
	assert.equal(structuredCall.options.env.AGY_ADC_AUTH, undefined);

	const defaultAgy = client.config();
	assert.equal(defaultAgy.model, undefined);
	assert.equal(defaultAgy.effort, null);
	assert.ok(
		!client.interactiveCommand(defaultAgy, "p").args.includes("--effort"),
	);

	for (const [tools, shouldDenyRead] of [
		["", true],
		["Read,Grep,Glob", false],
	]) {
		await client.runStructured(
			defaultAgy,
			"branch prompt",
			{ type: "object" },
			{ tools },
		);
		const noBashCall = calls.at(-1);
		assert.equal(noBashCall.options.input, "branch prompt");
		assert.ok(!noBashCall.args.includes("--effort"));
		const noBashSettings = JSON.parse(
			noBashCall.args[noBashCall.args.indexOf("--settings") + 1],
		);
		assert.deepEqual(noBashSettings.permissions.allow, []);
		assert.ok(noBashSettings.permissions.deny.includes("command(*)"));
		assert.equal(
			noBashSettings.permissions.deny.includes("read_file(*)"),
			shouldDenyRead,
		);
	}

	const customModelClient = new AgentClient({
		cwd: root,
		workflow: "review",
		environment: {
			PATH: root,
			MDW_DEFAULT_PROVIDER: "agy",
			MDW_DEFAULT_MODEL: "custom-model",
			MDW_DEFAULT_EFFORT: "high",
		},
		run: async (args) => {
			calls.push({ args, options: {} });
			return {
				stdout: Buffer.from(
					JSON.stringify({
						status: "SUCCESS",
						structured_output: { ok: true },
					}),
				),
				stderr: Buffer.alloc(0),
			};
		},
	});
	const custom = customModelClient.config();
	assert.equal(custom.effort, "high");
	await customModelClient.runStructured(custom, "p", { type: "object" });
	assert.equal(
		calls.at(-1).args[calls.at(-1).args.indexOf("--effort") + 1],
		"high",
	);

	assert.throws(
		() =>
			new AgentClient({
				cwd: root,
				workflow: "review",
				environment: {
					PATH: root,
					MDW_DEFAULT_PROVIDER: "agy",
					MDW_DEFAULT_EFFORT: "ultracode",
				},
			}).config(),
		/agy に対応する値/,
	);
	assert.throws(
		() =>
			new AgentClient({
				cwd: root,
				workflow: "review",
				environment: {
					PATH: root,
					MDW_DEFAULT_PROVIDER: "agy",
					MDW_REVIEW_SECURITY_BILLING: "api",
				},
			}).config("security"),
		/agyのAPI課金/,
	);

	const failing = new AgentClient({
		cwd: root,
		workflow: "review",
		environment: { PATH: root, MDW_DEFAULT_PROVIDER: "agy" },
		run: async () => ({
			stdout: Buffer.from(JSON.stringify({ status: "ERROR", error: "boom" })),
			stderr: Buffer.alloc(0),
		}),
	});
	await assert.rejects(
		failing.runStructured(failing.config(), "prompt", { type: "object" }),
		/agyの構造化出力がありません/,
	);

	const denied = new AgentClient({
		cwd: root,
		workflow: "review",
		environment: { PATH: root, MDW_DEFAULT_PROVIDER: "agy" },
		run: async () => ({
			stdout: Buffer.from(
				JSON.stringify({
					status: "SUCCESS",
					response: "",
					denied_actions: [{ action: "command", display_name: "Bash" }],
				}),
			),
			stderr: Buffer.alloc(0),
		}),
	});
	await assert.rejects(
		denied.runStructured(denied.config(), "prompt", { type: "object" }),
		/ツール使用が拒否されたため、構造化出力を取得できませんでした/,
	);
});

test("runWritableStructured はシェル禁止可能なプロバイダーで最小権限を揃え codex を拒否する", async (t) => {
	const root = executables(t);
	const codexClient = new AgentClient({
		cwd: root,
		workflow: "review",
		environment: {
			PATH: root,
			MDW_REVIEW_FIX_PROVIDER: "codex",
		},
		run: async () => {
			throw new Error("codex は起動されないはず");
		},
	});
	await assert.rejects(
		codexClient.runWritableStructured(
			codexClient.config("fix"),
			"fix prompt",
			{
				type: "object",
			},
			{ role: "fix" },
		),
		/シェル実行を禁止できないため codex は使用できません。MDW_REVIEW_FIX_PROVIDER/,
	);

	for (const provider of ["claude", "agy"]) {
		const calls = [];
		const client = new AgentClient({
			cwd: root,
			workflow: "review",
			environment: {
				PATH: root,
				MDW_REVIEW_FIX_PROVIDER: provider,
			},
			run: async (args, options) => {
				calls.push({ args, options });
				if (provider === "agy") {
					return {
						stdout: Buffer.from(
							JSON.stringify({
								status: "SUCCESS",
								structured_output: { ok: true },
								denied_actions: [],
							}),
						),
						stderr: Buffer.alloc(0),
					};
				}
				return {
					stdout: Buffer.from(
						JSON.stringify({
							structured_output: { ok: true },
							permission_denials: [],
						}),
					),
					stderr: Buffer.alloc(0),
				};
			},
		});
		const result = await client.runWritableStructured(
			client.config("fix"),
			"fix prompt",
			{ type: "object" },
			{ denyWritePaths: [".github", ".mdw"], role: "fix" },
		);
		assert.deepEqual(result, { data: { ok: true }, permissionDenials: 0 });
		assert.equal(calls.length, 1);
		const { args, options } = calls[0];
		assert.equal(options.input, "fix prompt");
		if (provider === "claude") {
			assert.equal(args[args.indexOf("--permission-mode") + 1], "acceptEdits");
			assert.equal(
				args[args.indexOf("--tools") + 1],
				"Read,Grep,Glob,Edit,Write",
			);
		} else {
			assert.ok(args.includes("--sandbox"));
			assert.ok(args.includes("--disable-slash-commands"));
			const settings = JSON.parse(args[args.indexOf("--settings") + 1]);
			assert.deepEqual(settings.permissions.allow, [
				`read_file(${root})`,
				`write_file(${root})`,
			]);
			assert.ok(settings.permissions.deny.includes("command(*)"));
			assert.ok(settings.permissions.deny.includes("read_url(*)"));
			assert.ok(settings.permissions.deny.includes("mcp(*)"));
			assert.ok(
				settings.permissions.deny.includes(
					`write_file(${path.join(root, ".git")})`,
				),
			);
			assert.ok(
				settings.permissions.deny.includes(
					`write_file(${path.join(root, ".github")})`,
				),
			);
			assert.ok(
				settings.permissions.deny.includes(
					`write_file(${path.join(root, ".mdw")})`,
				),
			);
		}
	}
});
