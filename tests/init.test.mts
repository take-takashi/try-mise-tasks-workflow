import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	confDTemplate,
	mdwGitignoreTemplate,
	modelsEnvTemplate,
} from "../.mise/tasks/mdw/_lib/init.mts";
import { run as runInit } from "../.mise/tasks/mdw/init.mts";

const project = fileURLToPath(new URL("..", import.meta.url));

function runCmd(args: string[], cwd: string, env = process.env) {
	const result = spawnSync(args[0], args.slice(1), {
		cwd,
		env,
		encoding: "utf8",
	});
	assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
	return result.stdout.trim();
}

function createCopiedRepo(t: test.TestContext) {
	const temp = fs.mkdtempSync(path.join(os.tmpdir(), "mdw-init-test-"));
	t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
	const root = path.join(temp, "project");
	fs.mkdirSync(root);
	runCmd(["git", "init", "-q", "-b", "main"], root);
	runCmd(["git", "config", "commit.gpgsign", "false"], root);
	runCmd(["git", "config", "user.name", "Test User"], root);
	runCmd(["git", "config", "user.email", "test@example.com"], root);
	fs.cpSync(
		path.join(project, ".mise/tasks/mdw"),
		path.join(root, ".mise/tasks/mdw"),
		{ recursive: true },
	);
	return { temp, root };
}

test("空の Git リポジトリで mise run mdw:init が設定を配置し、mise の環境変数優先順位が機能する", (t) => {
	const { root } = createCopiedRepo(t);
	const cleanEnv = { ...process.env, MISE_TRUSTED_CONFIG_PATHS: root };
	for (const key of Object.keys(cleanEnv)) {
		if (key.startsWith("MDW_") || key.startsWith("AWF_")) delete cleanEnv[key];
	}

	// --dry-run ではファイルを作成せず計画のみ返す。
	const dryOutput = JSON.parse(
		runCmd(["mise", "run", "mdw:init", "--dry-run"], root, cleanEnv),
	);
	assert.equal(dryOutput.dry_run, true);
	assert.deepEqual(
		dryOutput.files.map((item) => [item.path, item.action]),
		[
			[".mise/conf.d/mdw.toml", "would_create"],
			[".mdw/.gitignore", "would_create"],
			[".mdw/models.env", "would_create"],
		],
	);
	assert.equal(fs.existsSync(path.join(root, ".mise/conf.d/mdw.toml")), false);
	assert.equal(fs.existsSync(path.join(root, ".mdw/models.env")), false);

	// 通常実行で 3 ファイルを作成する。
	const initOutput = JSON.parse(
		runCmd(["mise", "run", "mdw:init"], root, cleanEnv),
	);
	assert.equal(initOutput.dry_run, false);
	assert.deepEqual(
		initOutput.files.map((item) => [item.path, item.action]),
		[
			[".mise/conf.d/mdw.toml", "created"],
			[".mdw/.gitignore", "created"],
			[".mdw/models.env", "created"],
		],
	);
	assert.equal(
		fs.readFileSync(path.join(root, ".mise/conf.d/mdw.toml"), "utf8"),
		confDTemplate,
	);
	assert.equal(
		fs.readFileSync(path.join(root, ".mdw/.gitignore"), "utf8"),
		mdwGitignoreTemplate,
	);
	const modelsContent = fs.readFileSync(
		path.join(root, ".mdw/models.env"),
		"utf8",
	);
	assert.equal(modelsContent, modelsEnvTemplate);
	// 雛形に API キー等の秘密情報を含めない。
	assert.equal(/API_KEY\s*=|TOKEN\s*=|SECRET\s*=/i.test(modelsContent), false);

	// .mdw/.gitignore により .mdw/models.local.env が Git の無視対象になる。
	fs.writeFileSync(
		path.join(root, ".mdw/models.local.env"),
		"MDW_DEFAULT_EFFORT=high\n",
	);
	assert.equal(
		spawnSync("git", ["check-ignore", "-q", ".mdw/models.local.env"], {
			cwd: root,
		}).status,
		0,
	);

	// mise が .mise/conf.d/mdw.toml 経由で .mdw/models.env → .mdw/models.local.env → mise.local.toml を解決する。
	fs.writeFileSync(
		path.join(root, "mise.local.toml"),
		'[env]\nMDW_DEFAULT_PROVIDER = "agy"\n',
	);
	const envJson = JSON.parse(runCmd(["mise", "env", "--json"], root, cleanEnv));
	assert.equal(envJson.MDW_DEFAULT_PROVIDER, "agy");
	assert.equal(envJson.MDW_DEFAULT_EFFORT, "high");
	assert.equal(envJson.MDW_DEFAULT_BILLING, "subscription");
});

test("サブディレクトリ実行・再実行スキップ・--force 時の保護範囲を検証する", async (t) => {
	const { root } = createCopiedRepo(t);
	const subdir = path.join(root, "nested/sub");
	fs.mkdirSync(subdir, { recursive: true });

	const first = await runInit({ cwd: subdir });
	assert.equal(first.root, fs.realpathSync(root));
	assert.ok(first.files.every((item) => item.action === "created"));

	// 既存ファイルを変更して再実行（既定はすべてスキップ）。
	fs.writeFileSync(
		path.join(root, ".mise/conf.d/mdw.toml"),
		"# custom old conf\n",
	);
	fs.writeFileSync(
		path.join(root, ".mdw/models.env"),
		"MDW_DEFAULT_PROVIDER=agy\n",
	);

	const second = await runInit({ cwd: subdir });
	assert.deepEqual(
		second.files.map((item) => [item.path, item.action, item.differs]),
		[
			[".mise/conf.d/mdw.toml", "skipped", true],
			[".mdw/.gitignore", "skipped", false],
			[".mdw/models.env", "skipped", true],
		],
	);
	assert.ok(second.next_steps.some((step) => step.includes("--force")));
	assert.equal(
		fs.readFileSync(path.join(root, ".mise/conf.d/mdw.toml"), "utf8"),
		"# custom old conf\n",
	);

	// --force 指定時は MDW 管理ファイルのみ更新し .mdw/models.env は絶対に上書きしない。
	const forced = await runInit({ cwd: subdir, force: true });
	assert.deepEqual(
		forced.files.map((item) => [item.path, item.action]),
		[
			[".mise/conf.d/mdw.toml", "updated"],
			[".mdw/.gitignore", "unchanged"],
			[".mdw/models.env", "skipped"],
		],
	);
	assert.equal(
		fs.readFileSync(path.join(root, ".mise/conf.d/mdw.toml"), "utf8"),
		confDTemplate,
	);
	assert.equal(
		fs.readFileSync(path.join(root, ".mdw/models.env"), "utf8"),
		"MDW_DEFAULT_PROVIDER=agy\n",
	);
});

test("Git 管理外・不明オプション・シンボリックリンクを拒否する", async (t) => {
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "mdw-init-nogit-"));
	t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
	await assert.rejects(runInit({ cwd: outside }), /Git リポジトリ内/);
	assert.equal(fs.existsSync(path.join(outside, ".mdw")), false);
	assert.equal(fs.existsSync(path.join(outside, ".mise")), false);

	const { temp, root } = createCopiedRepo(t);
	const escapeDir = path.join(temp, "escape");
	fs.mkdirSync(escapeDir);
	fs.symlinkSync(escapeDir, path.join(root, ".mdw"));
	await assert.rejects(runInit({ cwd: root }), /シンボリックリンク/);
	assert.equal(fs.existsSync(path.join(escapeDir, "models.env")), false);
	fs.rmSync(path.join(root, ".mdw"));

	// 不明オプションを直接渡したときはエラーになる。
	const bad = spawnSync(
		process.execPath,
		[path.join(root, ".mise/tasks/mdw/init.mts"), "--unknown-flag"],
		{ cwd: root, encoding: "utf8" },
	);
	assert.equal(bad.status, 1);
	assert.match(bad.stderr, /mise run/);
});

test("実行権限不足・mise.toml 重複・AI CLI や gh 不在を診断し正常終了する", async (t) => {
	const { root } = createCopiedRepo(t);
	fs.writeFileSync(
		path.join(root, "mise.toml"),
		'[env]\n_.file = [".mdw/models.env"]\n',
	);
	const targetTask = path.join(root, ".mise/tasks/mdw/check.mts");
	if (process.platform !== "win32") {
		fs.chmodSync(targetTask, 0o644);
	}

	const result = await runInit({
		cwd: root,
		env: { PATH: "" },
	});

	assert.equal(result.diagnostics.git.found, false);
	assert.equal(result.diagnostics.gh.found, false);
	assert.deepEqual(result.diagnostics.ai_clis.detected, []);
	assert.deepEqual(result.diagnostics.mise_toml_overlap, ["mise.toml"]);
	if (process.platform !== "win32") {
		assert.ok(
			result.diagnostics.task_permissions.missing_executable.includes(
				".mise/tasks/mdw/check.mts",
			),
		);
		assert.ok(result.next_steps.some((step) => step.includes("chmod +x")));
	}
	assert.ok(result.diagnostics.warnings.length >= 3);
});
