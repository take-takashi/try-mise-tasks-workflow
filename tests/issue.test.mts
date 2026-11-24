import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AgentClient } from "../.mise/tasks/mdw/_lib/agent-client.mts";
import { buildIssuePrompt } from "../.mise/tasks/mdw/_lib/issue.mts";

const project = fileURLToPath(new URL("..", import.meta.url));
const task = new URL("../.mise/tasks/mdw/issue/new.mts", import.meta.url).href;

function fixture(t) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "mdw-issue-test-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	fs.mkdirSync(path.join(root, "nested"));
	const git = spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
	assert.equal(git.status, 0);
	return root;
}

test("コピー先でタスクを検出し、ファイルを変更せずプロンプトを出力する", (t) => {
	const root = fixture(t);
	fs.cpSync(
		path.join(project, ".mise/tasks/mdw"),
		path.join(root, ".mise/tasks/mdw"),
		{ recursive: true },
	);
	const env = {
		...process.env,
		MISE_YES: "1",
		MDW_ISSUE_PROVIDER: "invalid",
	};
	delete env.MISE_ORIGINAL_CWD;
	const run = (args) =>
		spawnSync("mise", args, {
			cwd: path.join(root, "nested"),
			env,
			encoding: "utf8",
		});
	const listing = run(["tasks", "ls", "--json"]);
	assert.equal(listing.status, 0, listing.stderr);
	const names = JSON.parse(listing.stdout).map((item) => item.name);
	assert.ok(names.includes("mdw:issue:new"));
	assert.ok(!names.some((name) => name.startsWith("mdw:prompts:")));

	const help = run(["run", "mdw:issue:new", "--help"]);
	assert.equal(help.status, 0, help.stderr);
	assert.match(help.stdout, /--prompt/);
	assert.match(help.stdout, /topic/i);

	const plain = run(["run", "mdw:issue:new", "--prompt"]);
	assert.equal(plain.status, 0, plain.stderr);
	assert.equal(plain.stdout.trim(), buildIssuePrompt().trim());

	const blank = run(["run", "mdw:issue:new", "--prompt", "   "]);
	assert.equal(blank.status, 0, blank.stderr);
	assert.equal(blank.stdout.trim(), buildIssuePrompt().trim());
	assert.ok(!blank.stdout.includes("## 今回のテーマ"));

	const withTopic = run([
		"run",
		"mdw:issue:new",
		"--prompt",
		"  agy プロバイダーを追加したい  ",
	]);
	assert.equal(withTopic.status, 0, withTopic.stderr);
	assert.equal(
		withTopic.stdout.trim(),
		buildIssuePrompt("agy プロバイダーを追加したい").trim(),
	);
	assert.match(withTopic.stdout, /## 今回のテーマ/);
	assert.ok(withTopic.stdout.includes('"agy プロバイダーを追加したい"'));
	assert.ok(!fs.existsSync(path.join(root, "docs")));
});

test("issue 用の設定を優先し、API キーを適切な子プロセスにだけ渡す", (t) => {
	const root = fixture(t);
	const bin = path.join(root, "bin");
	fs.mkdirSync(bin);
	for (const provider of ["codex", "claude"])
		fs.writeFileSync(path.join(bin, provider), "", { mode: 0o755 });
	const command = (environment) => {
		const agent = new AgentClient({
			cwd: root,
			workflow: "issue",
			environment: { ...environment, PATH: bin },
		});
		return agent.interactiveCommand(agent.config(), "prompt");
	};
	const env = {
		MDW_DEFAULT_PROVIDER: "codex",
		MDW_DEFAULT_MODEL: "default-model",
		MDW_DEFAULT_EFFORT: "low",
		MDW_ISSUE_PROVIDER: "claude",
		MDW_ISSUE_MODEL: "sonnet",
		MDW_ISSUE_EFFORT: "high",
		MDW_ISSUE_BILLING: "api",
		MDW_ANTHROPIC_API_KEY: "test-key",
		OPENAI_API_KEY: "unrelated-key",
	};
	const claude = command(env);
	assert.equal(claude.executable, path.join(bin, "claude"));
	assert.deepEqual(claude.args, [
		"--effort",
		"high",
		"--model",
		"sonnet",
		"prompt",
	]);
	assert.equal(claude.env.ANTHROPIC_API_KEY, "test-key");
	assert.equal(claude.env.MDW_ANTHROPIC_API_KEY, undefined);
	assert.equal(claude.env.OPENAI_API_KEY, undefined);
	assert.equal(env.MDW_ANTHROPIC_API_KEY, "test-key");

	const codex = command({
		MDW_DEFAULT_EFFORT: "low",
	});
	assert.equal(codex.executable, path.join(bin, "codex"));
	assert.ok(!codex.args.includes("--model"));
	assert.ok(codex.args.includes('model_reasoning_effort="low"'));
	assert.ok(!codex.args.includes("exec"));
	assert.ok(!claude.args.includes("-p"));

	for (const settings of [
		{ MDW_ISSUE_PROVIDER: "invalid" },
		{ MDW_ISSUE_BILLING: "api" },
		{ MDW_ISSUE_EFFORT: "invalid" },
	])
		assert.throws(() => command(settings));
});

test("CLI に worktree のルートとテーマ付きプロンプトを渡し、終了コードを返す", (t) => {
	const root = fixture(t);
	const bin = path.join(root, "fake bin");
	fs.mkdirSync(bin);
	for (const provider of ["codex", "claude", "agy"]) {
		fs.writeFileSync(
			path.join(bin, provider),
			`#!/usr/bin/env node
if (process.argv[2] === "login") { console.log("Logged in using ChatGPT"); process.exit(0); }
if (process.argv[2] === "auth") { console.log(JSON.stringify({authMethod:"claude.ai"})); process.exit(0); }
if (process.argv[2] === "models") { console.log("gemini-3.8-flash-medium"); process.exit(0); }
console.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2),key:process.env.OPENAI_API_KEY}));
process.exitCode = 7;
`,
			{ mode: 0o755 },
		);
		const result = spawnSync(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`Object.defineProperty(process.stdin, "isTTY", {value:true});
Object.defineProperty(process.stdout, "isTTY", {value:true});
const {run} = await import(${JSON.stringify(task)});
process.exitCode = await run({topic:"テーマ確認"});`,
			],
			{
				cwd: path.join(root, "nested"),
				encoding: "utf8",
				env: {
					...process.env,
					PATH: `${bin}${path.delimiter}${process.env.PATH}`,
					MISE_ORIGINAL_CWD: path.join(root, "nested"),
					MDW_ISSUE_PROVIDER: provider,
					MDW_ISSUE_MODEL: "test-model",
					MDW_ISSUE_EFFORT: "medium",
					MDW_ISSUE_BILLING: "subscription",
					MDW_REVIEW_TIMEOUT_SECONDS: "invalid",
					OPENAI_API_KEY: "unrelated-key",
				},
			},
		);
		assert.equal(result.status, 7, result.stderr);
		const received = JSON.parse(result.stdout.trim().split("\n").at(-1));
		assert.equal(fs.realpathSync(received.cwd), fs.realpathSync(root));
		assert.equal(
			received.args.at(-1),
			provider === "agy"
				? `--prompt-interactive=${buildIssuePrompt("テーマ確認")}`
				: buildIssuePrompt("テーマ確認"),
		);
		assert.equal(received.key, undefined);
		assert.equal(
			received.args[received.args.indexOf("--model") + 1],
			"test-model",
		);
	}
	assert.ok(!fs.existsSync(path.join(root, "docs")));
});

test("端末がない場合は CLI を起動せず、プロンプト出力の使い方を案内する", (t) => {
	const root = fixture(t);
	const result = spawnSync(process.execPath, [fileURLToPath(task)], {
		cwd: root,
		encoding: "utf8",
		env: {
			...process.env,
			MISE_ORIGINAL_CWD: root,
			usage_prompt: "false",
			MDW_ISSUE_PROVIDER: "codex",
			MDW_ISSUE_BILLING: "subscription",
			MDW_ISSUE_EFFORT: "medium",
		},
	});
	assert.equal(result.status, 1);
	assert.match(result.stderr, /端末が必要.*--prompt/);
	assert.ok(!fs.existsSync(path.join(root, "docs")));
});
