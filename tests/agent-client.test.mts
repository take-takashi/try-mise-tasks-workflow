import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentClient } from "../.mise/tasks/mdw/_lib/agent-client.mts";

function executables(t) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "mdw-agent-config-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	for (const provider of ["codex", "claude"])
		fs.writeFileSync(path.join(root, provider), "", { mode: 0o755 });
	return root;
}

test("各ワークフローの設定を優先し、共通の検証で不正値を拒否する", (t) => {
	const root = executables(t);
	for (const workflow of ["review", "interview", "worktree"]) {
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
	for (const workflow of ["review", "interview", "worktree"]) {
		for (const provider of ["codex", "claude"]) {
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
							: JSON.stringify({ authMethod: "api_key" }),
					),
					stderr: Buffer.alloc(0),
				}),
			});
			await assert.rejects(client.check(), /認証/);
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
