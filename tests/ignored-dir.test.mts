import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureIgnoredDirectory } from "../.mise/tasks/mdw/_lib/ignored-dir.mts";
import { ReviewWorkspace } from "../.mise/tasks/mdw/_lib/review-workspace.mts";
import { cleanupWorktree } from "../.mise/tasks/mdw/worktree/cleanup.mts";
import { createWorktree } from "../.mise/tasks/mdw/worktree/new.mts";

function run(args: string[], cwd: string) {
	const result = spawnSync(args[0], args.slice(1), {
		cwd,
		encoding: "utf8",
	});
	assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
	return result.stdout.trim();
}

function createRepoWithoutRootGitignore(t: test.TestContext) {
	const temp = fs.mkdtempSync(path.join(os.tmpdir(), "mdw-ignored-dir-test-"));
	t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
	const bare = path.join(temp, "remote.git");
	const root = path.join(temp, "project");
	run(["git", "init", "--bare", "--initial-branch=main", bare], temp);
	run(["git", "clone", bare, root], temp);
	run(["git", "config", "commit.gpgsign", "false"], root);
	run(["git", "config", "user.name", "Test User"], root);
	run(["git", "config", "user.email", "test@example.com"], root);
	fs.writeFileSync(path.join(root, "readme.txt"), "initial\n");
	run(["git", "add", "readme.txt"], root);
	run(["git", "commit", "-m", "initial"], root);
	run(["git", "push", "-u", "origin", "main"], root);
	return { temp, bare, root };
}

test(".reviews/ と .worktree/ の作成時に自己無視する .gitignore を自動生成し、ルート .gitignore を変更しない", async (t) => {
	const { root } = createRepoWithoutRootGitignore(t);
	const workspace = new ReviewWorkspace(root);

	workspace.reset();
	workspace.write("merged.json", { ok: true });

	const reviewGitignore = path.join(root, ".reviews/.gitignore");
	assert.equal(
		fs.readFileSync(reviewGitignore, "utf8"),
		"# Created by MDW\n*\n",
	);
	assert.equal(fs.existsSync(path.join(root, ".gitignore")), false);
	assert.equal(
		run(["git", "status", "--porcelain", "--untracked-files=normal"], root),
		"",
	);
	assert.equal(
		spawnSync("git", ["check-ignore", "-q", ".reviews/merged.json"], {
			cwd: root,
		}).status,
		0,
	);

	// reset() を再実行しても成果物だけを削除し .reviews/.gitignore は保持する。
	workspace.reset();
	assert.equal(fs.existsSync(path.join(root, ".reviews/merged.json")), false);
	assert.equal(
		fs.readFileSync(reviewGitignore, "utf8"),
		"# Created by MDW\n*\n",
	);

	// worktree 作成時もルート .gitignore なしで親・子ともに未追跡ファイルを出さない。
	const created = await createWorktree({
		cwd: root,
		branch: "feat/auto-ignore",
	});
	const worktreeGitignore = path.join(root, ".worktree/.gitignore");
	assert.equal(
		fs.readFileSync(worktreeGitignore, "utf8"),
		"# Created by MDW\n*\n",
	);
	assert.equal(fs.existsSync(path.join(root, ".gitignore")), false);
	assert.equal(
		run(["git", "status", "--porcelain", "--untracked-files=normal"], root),
		"",
	);
	assert.equal(
		run(
			["git", "status", "--porcelain", "--untracked-files=all", "--ignored"],
			created.path,
		),
		"",
	);
});

test("既存の .gitignore を上書きせず、write() 先行呼び出しでも自動生成し、cleanup の安全策を維持する", async (t) => {
	const { root } = createRepoWithoutRootGitignore(t);

	// reset() を通らず write() から先に呼ばれた場合も .reviews/.gitignore を作成する。
	const workspace = new ReviewWorkspace(root);
	workspace.write("manifest.json", { run_id: "1" });
	assert.equal(
		fs.readFileSync(path.join(root, ".reviews/.gitignore"), "utf8"),
		"# Created by MDW\n*\n",
	);

	// 既存の独自 .gitignore は上書きしない。
	fs.writeFileSync(path.join(root, ".reviews/.gitignore"), "custom-rule\n");
	workspace.reset();
	assert.equal(
		fs.readFileSync(path.join(root, ".reviews/.gitignore"), "utf8"),
		"custom-rule\n",
	);

	fs.mkdirSync(path.join(root, ".worktree"), { recursive: true });
	fs.writeFileSync(path.join(root, ".worktree/.gitignore"), "custom-wt\n");
	const item = await createWorktree({ cwd: root, branch: "feat/keep-custom" });
	assert.equal(
		fs.readFileSync(path.join(root, ".worktree/.gitignore"), "utf8"),
		"custom-wt\n",
	);

	// worktree 内でレビュー成果物を生成した状態では、マージ済みでも cleanup を拒否する。
	fs.writeFileSync(path.join(item.path, "change.txt"), "done\n");
	run(["git", "add", "change.txt"], item.path);
	run(["git", "commit", "-m", "change"], item.path);
	run(["git", "merge", "--no-ff", item.branch, "-m", "merge"], root);

	const wtWorkspace = new ReviewWorkspace(item.path);
	wtWorkspace.write("merged.json", { reviewed: true });
	assert.throws(
		() => cleanupWorktree({ cwd: root, target: item.path }),
		/無視された/,
	);
});

test("シンボリックリンクや通常ファイルでない対象を拒否する", async (t) => {
	const { temp, root } = createRepoWithoutRootGitignore(t);
	const outside = path.join(temp, "outside");
	fs.mkdirSync(outside);
	const outsideFile = path.join(outside, "target.txt");
	fs.writeFileSync(outsideFile, "untouched\n");

	// .reviews 自体がシンボリックリンクの場合
	fs.symlinkSync(outside, path.join(root, ".reviews"));
	const workspace = new ReviewWorkspace(root);
	assert.throws(() => workspace.reset(), /シンボリックリンク/);
	assert.throws(() => workspace.write("merged.json", {}), /シンボリックリンク/);
	assert.equal(fs.existsSync(path.join(outside, ".gitignore")), false);
	fs.rmSync(path.join(root, ".reviews"));

	// .reviews/.gitignore がシンボリックリンクの場合
	fs.mkdirSync(path.join(root, ".reviews"));
	fs.symlinkSync(outsideFile, path.join(root, ".reviews/.gitignore"));
	assert.throws(() => workspace.reset(), /シンボリックリンク/);
	assert.equal(fs.readFileSync(outsideFile, "utf8"), "untouched\n");
	fs.rmSync(path.join(root, ".reviews"), { recursive: true, force: true });

	// .reviews/.gitignore がディレクトリの場合
	fs.mkdirSync(path.join(root, ".reviews/.gitignore"), { recursive: true });
	assert.throws(() => workspace.reset(), /通常ファイルではありません/);
	fs.rmSync(path.join(root, ".reviews"), { recursive: true, force: true });

	// .reviews が通常ファイルの場合
	fs.writeFileSync(path.join(root, ".reviews"), "not-a-dir");
	assert.throws(
		() => ensureIgnoredDirectory(path.join(root, ".reviews"), ".reviews"),
		/ディレクトリではありません/,
	);
	fs.rmSync(path.join(root, ".reviews"));

	// .worktree 自体がシンボリックリンクの場合
	fs.symlinkSync(outside, path.join(root, ".worktree"));
	await assert.rejects(
		createWorktree({ cwd: root, branch: "feat/symlink-dir" }),
		/シンボリックリンク/,
	);
	assert.equal(fs.existsSync(path.join(outside, ".gitignore")), false);
	fs.rmSync(path.join(root, ".worktree"));

	// .worktree/.gitignore がシンボリックリンクの場合
	fs.mkdirSync(path.join(root, ".worktree"));
	fs.symlinkSync(outsideFile, path.join(root, ".worktree/.gitignore"));
	await assert.rejects(
		createWorktree({ cwd: root, branch: "feat/symlink-gitignore" }),
		/シンボリックリンク/,
	);
	assert.equal(fs.readFileSync(outsideFile, "utf8"), "untouched\n");
});
