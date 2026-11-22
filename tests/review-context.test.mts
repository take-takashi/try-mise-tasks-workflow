import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentClient } from "../.mise/tasks/mdw/_lib/agent-client.mts";
import {
	prepare,
	saveReviewSummary,
	summarizeReviews,
} from "../.mise/tasks/mdw/_lib/review-steps.mts";
import { ReviewWorkspace } from "../.mise/tasks/mdw/_lib/review-workspace.mts";

function git(cwd, ...args) {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	return result.stdout.trim();
}

function repository(root, filename) {
	fs.mkdirSync(path.join(root, "nested"), { recursive: true });
	git(root, "init", "-q", "-b", "main");
	git(root, "config", "user.name", "Test");
	git(root, "config", "user.email", "test@example.com");
	fs.writeFileSync(path.join(root, filename), "before\n");
	git(root, "add", ".");
	git(root, "commit", "-qm", "before");
	const baseRef = git(root, "rev-parse", "HEAD");
	fs.writeFileSync(path.join(root, filename), "after\n");
	git(root, "commit", "-qam", "after");
	return { baseRef, headRef: "HEAD" };
}

test("複数のリポジトリを並行して準備しても、対象と保存先が混ざらない", async (t) => {
	const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "mdw-workspaces-"));
	t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
	const roots = ["first", "second"].map((name) => path.join(temporary, name));
	const options = roots.map((root, index) => repository(root, `${index}.txt`));
	const workspaces = await Promise.all(
		roots.map((root) => ReviewWorkspace.discover(path.join(root, "nested"))),
	);
	const manifests = await Promise.all(
		workspaces.map((workspace, index) => prepare(options[index], workspace)),
	);

	for (const [index, workspace] of workspaces.entries()) {
		const manifest = manifests[index];
		assert.equal(
			fs.realpathSync(workspace.root),
			fs.realpathSync(roots[index]),
		);
		assert.deepEqual(
			manifest.changed_files.map((file) => file.path),
			[`${index}.txt`],
		);
		assert.deepEqual(workspace.read("manifest.json"), manifest);
		const reviews = ["security", "quality"].map((role) => ({
			reviewer_id: role,
			target: manifest,
			review: { findings: [], limitations: [], file_coverage: [] },
		}));
		const summary = summarizeReviews(manifest, reviews, workspace);
		assert.equal(
			saveReviewSummary(summary, workspace),
			path.join(workspace.output, "merged.json"),
		);
		assert.deepEqual(workspace.read("merged.json").target, manifest);
	}
	workspaces[0].reset();
	assert.ok(!fs.existsSync(path.join(workspaces[0].output, "merged.json")));
	assert.deepEqual(workspaces[1].read("merged.json").target, manifests[1]);
});

test("AgentClient は環境変数のスナップショットと実行先をクライアントごとに保持する", async (t) => {
	const temporary = fs.mkdtempSync(
		path.join(os.tmpdir(), "mdw-agent-clients-"),
	);
	t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
	const clients = ["codex", "claude"].map((provider, index) => {
		const cwd = path.join(temporary, provider);
		const bin = path.join(cwd, "bin");
		fs.mkdirSync(bin, { recursive: true });
		const executable = path.join(bin, provider);
		fs.writeFileSync(executable, "");
		fs.chmodSync(executable, 0o755);
		const environment = {
			PATH: "bin",
			MDW_REVIEW_PROVIDER: provider,
			MDW_REVIEW_MODEL: `model-${index}`,
			MDW_REVIEW_BILLING: provider === "claude" ? "api" : "subscription",
			MDW_REVIEW_TIMEOUT_SECONDS: String(20 + index),
			MDW_ANTHROPIC_API_KEY: "test-key",
			OPENAI_API_KEY: "foreign-key",
		};
		const calls = [];
		let resultFile = "";
		const client = new AgentClient({
			cwd,
			environment,
			run: async (args, options) => {
				calls.push({ args, options });
				await Promise.resolve();
				if (args[1] === "login")
					return {
						stdout: Buffer.from("Logged in using ChatGPT"),
						stderr: Buffer.alloc(0),
					};
				if (args[1] === "auth")
					return {
						stdout: Buffer.from('{"authMethod":"api_key"}'),
						stderr: Buffer.alloc(0),
					};
				if (provider === "codex") {
					resultFile = args[args.indexOf("-o") + 1];
					fs.writeFileSync(resultFile, JSON.stringify({ provider }));
					return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
				}
				return {
					stdout: Buffer.from(
						JSON.stringify({
							structured_output: { provider },
							permission_denials: [{}],
						}),
					),
					stderr: Buffer.alloc(0),
				};
			},
		});
		environment.PATH = "";
		environment.MDW_REVIEW_MODEL = "changed-model";
		environment.MDW_REVIEW_TIMEOUT_SECONDS = "999";
		environment.MDW_ANTHROPIC_API_KEY = "changed-key";
		return {
			client,
			calls,
			cwd,
			executable,
			provider,
			resultFile: () => resultFile,
		};
	});

	await Promise.all(clients.map(({ client }) => client.check(["security"])));
	const results = await Promise.all(
		clients.map(({ client }) =>
			client.runStructured(client.config("security"), "prompt", {
				type: "object",
			}),
		),
	);
	for (const [
		index,
		{ client, calls, cwd, executable, provider, resultFile },
	] of clients.entries()) {
		assert.equal(client.config("security").model, `model-${index}`);
		assert.deepEqual(results[index], {
			data: { provider },
			permissionDenials: index,
		});
		assert.equal(calls.length, 2);
		for (const { args, options } of calls) {
			assert.equal(args[0], executable);
			assert.equal(options.cwd, cwd);
			assert.equal(options.env.OPENAI_API_KEY, undefined);
			assert.equal(options.env.MDW_ANTHROPIC_API_KEY, undefined);
			assert.equal(
				options.env.ANTHROPIC_API_KEY,
				provider === "claude" ? "test-key" : undefined,
			);
		}
		assert.equal(calls[1].options.timeout, 20 + index);
		assert.equal(calls[1].options.input, "prompt");
		if (provider === "codex")
			assert.ok(!fs.existsSync(path.dirname(resultFile())));
	}
});
