import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { cleanupWorktree } from "../.mise/tasks/mdw/worktree/cleanup.mts";
import { createWorktree } from "../.mise/tasks/mdw/worktree/new.mts";

const project = fileURLToPath(new URL("..", import.meta.url));
function run(args, cwd, options = {}) {
	const result = spawnSync(args[0], args.slice(1), {
		cwd,
		encoding: "utf8",
		...options,
	});
	assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
	return result.stdout.trim();
}
function fixture(t) {
	const temp = fs.mkdtempSync(path.join(os.tmpdir(), "mdw-worktree-test-"));
	t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
	const bare = path.join(temp, "remote.git"),
		root = path.join(temp, "project");
	run(["git", "init", "--bare", "--initial-branch=main", bare], temp);
	run(["git", "clone", bare, root], temp);
	run(["git", "config", "commit.gpgsign", "false"], root);
	run(["git", "config", "user.name", "Test User"], root);
	run(["git", "config", "user.email", "test@example.com"], root);
	fs.writeFileSync(path.join(root, ".gitignore"), "/.worktree/\nignored.txt\n");
	fs.writeFileSync(path.join(root, "readme"), "initial\n");
	fs.cpSync(
		path.join(project, ".mise/tasks/mdw"),
		path.join(root, ".mise/tasks/mdw"),
		{ recursive: true },
	);
	run(["git", "add", "."], root);
	run(["git", "commit", "-m", "initial"], root);
	run(["git", "push", "-u", "origin", "main"], root);
	return { temp, bare, root };
}
function commit(root, file, text) {
	fs.writeFileSync(path.join(root, file), text);
	run(["git", "add", file], root);
	run(["git", "commit", "-m", "change"], root);
}
test("main の未プッシュのコミットを含めて作成し、重複時は別名を付ける", async (t) => {
	const { root } = fixture(t);
	commit(root, "local", "local\n");
	const expected = run(["git", "rev-parse", "main"], root);
	const a = await createWorktree({ cwd: root, branch: "feat/example" });
	const b = await createWorktree({ cwd: root, branch: "feat/example" });
	assert.equal(a.base_commit, expected);
	assert.equal(
		a.path,
		path.join(fs.realpathSync(root), ".worktree/feat-example"),
	);
	assert.equal(b.branch, "feat/example-2");
	assert.equal(run(["git", "rev-parse", "HEAD"], b.path), expected);
	await assert.rejects(
		createWorktree({ cwd: root, branch: "feat/../../escape" }),
	);
});
test("main の最新化、未コミット変更と履歴分岐の保護", async (t) => {
	const { temp, bare, root } = fixture(t);
	const other = path.join(temp, "other");
	run(["git", "clone", bare, other], temp);
	run(["git", "config", "commit.gpgsign", "false"], other);
	run(["git", "config", "user.name", "Test User"], other);
	run(["git", "config", "user.email", "test@example.com"], other);
	commit(other, "remote", "remote\n");
	run(["git", "push"], other);
	fs.writeFileSync(path.join(root, "local-untracked"), "keep");
	await assert.rejects(
		createWorktree({ cwd: root, branch: "fix/dirty" }),
		/未コミット/,
	);
	fs.rmSync(path.join(root, "local-untracked"));
	const created = await createWorktree({ cwd: root, branch: "fix/fresh" });
	assert.equal(created.base_commit, run(["git", "rev-parse", "HEAD"], other));
	commit(root, "local", "local\n");
	commit(other, "remote2", "remote2\n");
	run(["git", "push"], other);
	await assert.rejects(
		createWorktree({ cwd: root, branch: "fix/diverged" }),
		/分岐/,
	);
	assert.equal(fs.readFileSync(path.join(root, "local"), "utf8"), "local\n");
});
test("通常マージ後だけ対象を削除し、未追跡と無視されたファイルを保護する", async (t) => {
	const { root } = fixture(t);
	const item = await createWorktree({ cwd: root, branch: "feat/cleanup" });
	commit(item.path, "feature", "feature\n");
	assert.throws(
		() => cleanupWorktree({ cwd: root, target: item.path }),
		/マージ済み/,
	);
	run(["git", "merge", "--no-ff", item.branch, "-m", "merge"], root);
	fs.writeFileSync(path.join(item.path, "ignored.txt"), "keep");
	assert.throws(
		() => cleanupWorktree({ cwd: root, target: item.path }),
		/無視された/,
	);
	assert.equal(
		fs.readFileSync(path.join(item.path, "ignored.txt"), "utf8"),
		"keep",
	);
	fs.rmSync(path.join(item.path, "ignored.txt"));
	const output = cleanupWorktree({ cwd: root, target: item.path });
	assert.equal(output.removed, true);
	assert.equal(fs.existsSync(item.path), false);
	assert.notEqual(
		spawnSync(
			"git",
			["show-ref", "--verify", "--quiet", "refs/heads/feat/cleanup"],
			{ cwd: root },
		).status,
		0,
	);
});
test("squash マージを PR と差分の両方で確認する", async (t) => {
	const { temp, bare, root } = fixture(t);
	const item = await createWorktree({ cwd: root, branch: "feat/squashed" });
	commit(item.path, "feature", "feature\n");
	const head = run(["git", "rev-parse", "HEAD"], item.path);
	run(["git", "merge", "--squash", item.branch], root);
	run(["git", "commit", "-m", "squash"], root);
	const merge = run(["git", "rev-parse", "HEAD"], root);
	const fakebin = path.join(temp, "bin");
	fs.mkdirSync(fakebin);
	const response = JSON.stringify([
		{
			headRefOid: head,
			headRefName: item.branch,
			baseRefName: "main",
			mergedAt: "2026-01-01T00:00:00Z",
			mergeCommit: { oid: merge },
		},
	]);
	fs.writeFileSync(
		path.join(fakebin, "gh"),
		`#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(response)});\n`,
		{ mode: 0o755 },
	);
	run(
		[
			"git",
			"remote",
			"set-url",
			"origin",
			"https://github.com/example/project.git",
		],
		root,
	);
	run(
		[
			"git",
			"config",
			`url.${bare}.insteadOf`,
			"https://github.com/example/project.git",
		],
		root,
	);
	const previousPath = process.env.PATH;
	process.env.PATH = `${fakebin}${path.delimiter}${previousPath}`;
	try {
		assert.equal(
			cleanupWorktree({ cwd: root, target: item.path }).removed,
			true,
		);
	} finally {
		process.env.PATH = previousPath;
	}
});
test("コピーしたタスクを mise で検出し、指定された名前で実行する", (t) => {
	const { root } = fixture(t);
	const listed = JSON.parse(run(["mise", "tasks", "ls", "--json"], root));
	assert.ok(listed.some((item) => item.name === "mdw:worktree:new"));
	assert.ok(listed.some((item) => item.name === "mdw:worktree:cleanup"));
	const created = JSON.parse(
		run(
			["mise", "run", "mdw:worktree:new", "--branch", "feat/from-mise"],
			root,
		),
	);
	assert.equal(created.branch, "feat/from-mise");
	assert.ok(fs.existsSync(created.path));
});

test("自然文から Codex・Claude・agy の出力を使ってブランチ名を生成する", async (t) => {
	const { temp, root } = fixture(t);
	const bin = path.join(temp, "fake-ai");
	fs.mkdirSync(bin);
	fs.writeFileSync(
		path.join(bin, "codex"),
		'#!/usr/bin/env node\nconst fs = require("node:fs"); const args = process.argv; if (args[2] === "login") { console.log("Logged in using ChatGPT"); process.exit(0); } fs.writeFileSync(args[args.indexOf("-o") + 1], JSON.stringify({branch:"feat/codex-name"}));\n',
		{ mode: 0o755 },
	);
	fs.writeFileSync(
		path.join(bin, "claude"),
		'#!/usr/bin/env node\nif (process.argv[2] === "auth") { console.log(JSON.stringify({authMethod:"claude.ai"})); process.exit(0); } process.stdout.write(JSON.stringify({structured_output:{branch:"fix/claude-name"}}));\n',
		{ mode: 0o755 },
	);
	fs.writeFileSync(
		path.join(bin, "agy"),
		'#!/usr/bin/env node\nif (process.argv[2] === "models") { console.log("gemini-3.8-flash-medium"); process.exit(0); } process.stdout.write(JSON.stringify({status:"SUCCESS",structured_output:{branch:"refactor/agy-name"}}));\n',
		{ mode: 0o755 },
	);
	const keys = ["PATH", "MDW_WORKTREE_PROVIDER", "MDW_WORKTREE_BILLING"];
	const old = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
	process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
	process.env.MDW_WORKTREE_BILLING = "subscription";
	try {
		process.env.MDW_WORKTREE_PROVIDER = "codex";
		assert.equal(
			(await createWorktree({ cwd: root, task: "名前を作る" })).branch,
			"feat/codex-name",
		);
		process.env.MDW_WORKTREE_PROVIDER = "claude";
		assert.equal(
			(await createWorktree({ cwd: root, task: "問題を修正する" })).branch,
			"fix/claude-name",
		);
		process.env.MDW_WORKTREE_PROVIDER = "agy";
		assert.equal(
			(await createWorktree({ cwd: root, task: "構成を整理する" })).branch,
			"refactor/agy-name",
		);
	} finally {
		for (const key of keys) {
			if (old[key] === undefined) delete process.env[key];
			else process.env[key] = old[key];
		}
	}
});

test("リモートに同じ名前のブランチがある場合も別名を選ぶ", async (t) => {
	const { root } = fixture(t);
	run(["git", "push", "origin", "main:refs/heads/feat/remote-only"], root);
	const created = await createWorktree({
		cwd: root,
		branch: "feat/remote-only",
	});
	assert.equal(created.branch, "feat/remote-only-2");
});

test("squash マージ後に追加されたコミットは削除しない", async (t) => {
	const { temp, bare, root } = fixture(t);
	const item = await createWorktree({
		cwd: root,
		branch: "fix/changed-after-merge",
	});
	commit(item.path, "feature", "feature\n");
	const mergedHead = run(["git", "rev-parse", "HEAD"], item.path);
	run(["git", "merge", "--squash", item.branch], root);
	run(["git", "commit", "-m", "squash"], root);
	const merge = run(["git", "rev-parse", "HEAD"], root);
	commit(item.path, "later", "keep\n");
	const bin = path.join(temp, "bin");
	fs.mkdirSync(bin);
	const response = JSON.stringify([
		{
			headRefOid: mergedHead,
			headRefName: item.branch,
			baseRefName: "main",
			mergedAt: "2026-01-01T00:00:00Z",
			mergeCommit: { oid: merge },
		},
	]);
	fs.writeFileSync(
		path.join(bin, "gh"),
		`#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(response)});\n`,
		{ mode: 0o755 },
	);
	run(
		[
			"git",
			"remote",
			"set-url",
			"origin",
			"https://github.com/example/project.git",
		],
		root,
	);
	run(
		[
			"git",
			"config",
			`url.${bare}.insteadOf`,
			"https://github.com/example/project.git",
		],
		root,
	);
	const previousPath = process.env.PATH;
	process.env.PATH = `${bin}${path.delimiter}${previousPath}`;
	try {
		assert.throws(
			() => cleanupWorktree({ cwd: root, target: item.path }),
			/マージ済み/,
		);
		assert.equal(
			fs.readFileSync(path.join(item.path, "later"), "utf8"),
			"keep\n",
		);
	} finally {
		process.env.PATH = previousPath;
	}
});
