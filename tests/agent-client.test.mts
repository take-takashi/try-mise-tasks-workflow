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

test("agy の設定検証、エフォート衝突回避、環境分離、構造化出力の検証を行う", async (t) => {
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
	assert.equal(securityInteractive.env.OPENAI_API_KEY, undefined);

	const quality = client.config("quality");
	assert.equal(quality.model, "gemini-pro-orchestrator-neon");
	assert.equal(quality.effort, "high");
	await client.runStructured(quality, "-check", { type: "object" });
	const structuredCall = calls.at(-1);
	assert.ok(structuredCall.args.includes("--mode"));
	assert.ok(structuredCall.args.includes("plan"));
	assert.ok(structuredCall.args.includes("--sandbox"));
	assert.ok(structuredCall.args.includes("--print-timeout"));
	assert.ok(structuredCall.args.includes("45s"));
	assert.equal(
		structuredCall.args[structuredCall.args.indexOf("--effort") + 1],
		"high",
	);
	assert.equal(
		structuredCall.args[structuredCall.args.indexOf("--model") + 1],
		"gemini-pro-orchestrator-neon",
	);
	assert.equal(structuredCall.args.at(-1), "--print=-check");
	assert.equal(structuredCall.options.env.GEMINI_API_KEY, undefined);

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
});
