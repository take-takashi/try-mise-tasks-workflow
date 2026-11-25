import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	childEnvironment,
	resolveReviewSetting,
	timeoutSeconds,
} from "../.mise/tasks/mdw/_lib/agent-client.mts";
import { runCommand } from "../.mise/tasks/mdw/_lib/command.mts";
import { prepare, runRole } from "../.mise/tasks/mdw/_lib/review.mts";
import {
	buildReviewPrompt,
	validateReview,
} from "../.mise/tasks/mdw/_lib/review-data.mts";

const project = fileURLToPath(new URL("../", import.meta.url));
function command(file, args, options) {
	const result = spawnSync(file, args, { ...options, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr || String(result.error));
	return result.stdout.trim();
}

test("MDW設定を優先し、従来のAWF設定と秘密情報の分離を保つ", () => {
	const env = {
		AWF_REVIEW_TIMEOUT_SECONDS: "31",
		AWF_ANTHROPIC_API_KEY: "old-key",
		OPENAI_API_KEY: "foreign",
		AWF_REVIEW_SECURITY_MODEL: "old-model",
		MDW_DEFAULT_MODEL: "default-model",
	};
	assert.equal(timeoutSeconds(env), 31);
	assert.equal(
		resolveReviewSetting("security", "MODEL", "fallback", env),
		"old-model",
	);
	assert.equal(
		childEnvironment("claude", "api", env).ANTHROPIC_API_KEY,
		"old-key",
	);
	env.MDW_REVIEW_TIMEOUT_SECONDS = "12";
	env.MDW_ANTHROPIC_API_KEY = "new-key";
	env.MDW_REVIEW_SECURITY_MODEL = "new-model";
	assert.equal(timeoutSeconds(env), 12);
	assert.equal(
		resolveReviewSetting("security", "MODEL", "fallback", env),
		"new-model",
	);
	const child = childEnvironment("claude", "api", env);
	assert.equal(child.ANTHROPIC_API_KEY, "new-key");
	for (const key of [
		"MDW_ANTHROPIC_API_KEY",
		"AWF_ANTHROPIC_API_KEY",
		"OPENAI_API_KEY",
	])
		assert.equal(child[key], undefined);
	assert.equal(
		childEnvironment("codex", "subscription", env).ANTHROPIC_API_KEY,
		undefined,
	);
	assert.throws(
		() => timeoutSeconds({ MDW_REVIEW_TIMEOUT_SECONDS: "0" }),
		/正の整数/,
	);
	assert.throws(
		() => childEnvironment("claude", "api", {}),
		/MDW_ANTHROPIC_API_KEY/,
	);
});

test("不正なレビュー結果とタイムアウトを検出する", async () => {
	assert.throws(
		() =>
			validateReview({
				findings: [],
				limitations: [],
				file_coverage: [],
				extra: true,
			}),
		/不正/,
	);
	assert.throws(
		() =>
			validateReview({
				findings: [
					{
						severity: "high",
						file: "x",
						line: true,
						title: "x",
						evidence: "x",
						recommendation: "x",
					},
				],
				limitations: [],
				file_coverage: [],
			}),
		/不正/,
	);
	await assert.rejects(
		runCommand([process.execPath, "-e", "setTimeout(() => {}, 10000)"], {
			timeout: 0.1,
		}),
		/タイムアウト/,
	);
	await assert.rejects(
		runCommand([
			process.execPath,
			"-e",
			'console.error("private-output"); process.exit(3)',
		]),
		(error) =>
			error.message.includes("終了コード 3") &&
			!error.message.includes("private-output"),
	);
});

test("部品は不正なレビュー対象や観点を処理前に拒否する", async () => {
	await assert.rejects(prepare({ baseRef: " " }), /baseRef と headRef/);
	await assert.rejects(prepare({ headRef: 42 }), /baseRef と headRef/);
	await assert.rejects(runRole("unknown"), /不明なレビューの観点/);
});

test("レビュープロンプトは静的共通部・静的観点・動的対象の順に組み立てられ、欠損を検出する", (t) => {
	const manifest = {
		merge_base_commit: "1111111111111111111111111111111111111111",
		head_commit: "2222222222222222222222222222222222222222",
		changed_files: [
			{ path: "app.mts", binary: false, path_encoding_error: false },
		],
	};
	const security = buildReviewPrompt("security", manifest);
	const architecture = buildReviewPrompt("architecture", manifest);
	const quality = buildReviewPrompt("quality", manifest);
	const base = fs
		.readFileSync(
			path.join(project, ".mise/tasks/mdw/prompts/review/base.md"),
			"utf8",
		)
		.trim();
	for (const [role, prompt] of [
		["security", security],
		["architecture", architecture],
		["quality", quality],
	]) {
		const roleGuide = fs
			.readFileSync(
				path.join(project, `.mise/tasks/mdw/prompts/review/${role}.md`),
				"utf8",
			)
			.trim();
		assert.ok(prompt.startsWith(`${base}\n\n${roleGuide}\n\n## レビュー対象`));
		const dynamicIndex = prompt.indexOf("## レビュー対象");
		assert.ok(prompt.indexOf(manifest.merge_base_commit) > dynamicIndex);
		assert.ok(prompt.indexOf(manifest.head_commit) > dynamicIndex);
		assert.ok(prompt.indexOf("app.mts") > dynamicIndex);
	}
	assert.throws(
		() => buildReviewPrompt("unknown", manifest),
		/不明なレビューの観点/,
	);

	const brokenDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdw-prompt-test-"));
	t.after(() => fs.rmSync(brokenDir, { recursive: true, force: true }));
	assert.throws(
		() => buildReviewPrompt("security", manifest, { promptDir: brokenDir }),
		/読み取れません/,
	);
	fs.writeFileSync(path.join(brokenDir, "base.md"), "   \n");
	fs.writeFileSync(path.join(brokenDir, "security.md"), "security");
	assert.throws(
		() => buildReviewPrompt("security", manifest, { promptDir: brokenDir }),
		/空です/,
	);
});

test("Gitの変更一覧からバイナリーと非UTF-8のファイル名を保持する", (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "mdw-git-bytes-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const bin = path.join(root, "bin");
	fs.mkdirSync(bin);
	const fakeGit = [
		"#!/usr/bin/env node",
		"const a = process.argv.slice(2);",
		"if (a[0] === 'diff') process.stdout.write(Buffer.concat([Buffer.from('-\\t-\\tbinary.dat\\0'), Buffer.from('1\\t2\\tbad-'), Buffer.from([255]), Buffer.from('.txt\\0')]));",
		"else if (a.includes('--show-toplevel')) console.log(process.cwd());",
		"else console.log('1234567890abcdef');",
		"",
	].join("\n");
	const git = path.join(bin, "git");
	fs.writeFileSync(git, fakeGit);
	fs.chmodSync(git, 0o755);
	const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH };
	delete env.MISE_ORIGINAL_CWD;
	const script = path.join(project, ".mise/tasks/mdw/review/prepare.mts");
	command(process.execPath, [script], { cwd: root, env });
	const manifest = JSON.parse(
		fs.readFileSync(path.join(root, ".reviews/manifest.json"), "utf8"),
	);
	assert.deepEqual(manifest.changed_files, [
		{ path: "binary.dat", binary: true, path_encoding_error: false },
		{ path: "bad-\\xff.txt", binary: false, path_encoding_error: true },
	]);
});

test("コピーしたMDWをmiseから実行し、異なるプロバイダーを並列に集約する", (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "mdw-review-test-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const tasks = path.join(root, ".mise/tasks");
	fs.cpSync(path.join(project, ".mise/tasks/mdw"), path.join(tasks, "mdw"), {
		recursive: true,
	});
	const cwd = root;
	command("git", ["init", "-q", "-b", "main"], { cwd });
	fs.writeFileSync(path.join(root, "sample.txt"), "before");
	command("git", ["add", "sample.txt"], { cwd });
	command(
		"git",
		[
			"-c",
			"user.name=MDW Test",
			"-c",
			"user.email=mdw@example.invalid",
			"commit",
			"-q",
			"-m",
			"before",
		],
		{ cwd },
	);
	const base = command("git", ["rev-parse", "HEAD"], { cwd });
	command("git", ["switch", "-q", "-c", "feature"], { cwd });
	fs.writeFileSync(path.join(root, "sample.txt"), "after");
	command("git", ["add", "sample.txt"], { cwd });
	command(
		"git",
		[
			"-c",
			"user.name=MDW Test",
			"-c",
			"user.email=mdw@example.invalid",
			"commit",
			"-q",
			"-m",
			"after",
		],
		{ cwd },
	);
	const head = command("git", ["rev-parse", "HEAD"], { cwd });
	const bin = path.join(root, "bin"),
		control = path.join(root, "control");
	fs.mkdirSync(bin);
	fs.mkdirSync(control);
	const fake = [
		"#!/usr/bin/env node",
		"const fs = require('node:fs'), path = require('node:path');",
		"const name = path.basename(process.argv[1]), args = process.argv.slice(2);",
		"if (process.env.MDW_ANTHROPIC_API_KEY || process.env.AWF_ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY) process.exit(7);",
		"if (name === 'claude' && process.env.ANTHROPIC_API_KEY !== 'test-key') process.exit(8);",
		"if (name !== 'claude' && process.env.ANTHROPIC_API_KEY) process.exit(9);",
		"if (name === 'codex' && args[0] === 'login') { console.log('Logged in using ChatGPT'); process.exit(0); }",
		"if (name === 'claude' && args[0] === 'auth') { console.log(JSON.stringify({authMethod:'api_key'})); process.exit(0); }",
		"if (name === 'agy' && args[0] === 'models') { console.log('gemini-4-neon-medium Gemini 4 Neon (Medium)'); process.exit(0); }",
		"if (name === 'codex' && args.includes('--model')) process.exit(13);",
		"if (name === 'claude' && args[args.indexOf('--model') + 1] !== 'sonnet') process.exit(14);",
		"if (name === 'agy' && args[args.indexOf('--model') + 1] !== 'gemini-4-neon-medium') process.exit(15);",
		"process.stdin.resume(); process.stdin.on('end', () => {",
		"  fs.writeFileSync(path.join(process.env.TEST_CONTROL, name), 'started');",
		"  const end = Date.now() + 3000; const peers = ['codex', 'claude', 'agy'].filter((item) => item !== name);",
		"  const timer = setInterval(() => {",
		"    if (Date.now() > end) { clearInterval(timer); process.exit(10); }",
		"    if (process.env.TEST_SOLO !== '1' && !peers.every((peer) => fs.existsSync(path.join(process.env.TEST_CONTROL, peer)))) return;",
		"    clearInterval(timer); const review = {findings: [], limitations: [], file_coverage: [{file:'sample.txt', status:'reviewed', detail:'fake'}]};",
		"    if (process.env.TEST_FAIL_REVIEW === name) process.exit(12);",
		"    if (name === 'codex') fs.writeFileSync(args[args.indexOf('-o') + 1], JSON.stringify(review));",
		"    else if (name === 'agy') console.log(JSON.stringify({status:'SUCCESS', structured_output:review, denied_actions:[]}));",
		"    else console.log(JSON.stringify({structured_output:review, permission_denials:[]}));",
		"  }, 20);",
		"});",
		"",
	].join("\n");
	for (const name of ["codex", "claude", "agy"]) {
		fs.writeFileSync(path.join(bin, name), fake);
		fs.chmodSync(path.join(bin, name), 0o755);
	}
	const env = Object.fromEntries(
		Object.entries(process.env).filter(
			([key]) =>
				!key.startsWith("MDW_") &&
				!key.startsWith("AWF_") &&
				key !== "MISE_ORIGINAL_CWD",
		),
	);
	Object.assign(env, {
		MISE_YES: "1",
		PATH: bin + path.delimiter + env.PATH,
		TEST_CONTROL: control,
		MDW_REVIEW_BASE: "invalid-ref",
		AWF_REVIEW_BASE: "invalid-ref",
		MDW_REVIEW_HEAD: "invalid-ref",
		MDW_REVIEW_TIMEOUT_SECONDS: "10",
		AWF_REVIEW_TIMEOUT_SECONDS: "invalid",
		MDW_REVIEW_SECURITY_PROVIDER: "claude",
		MDW_REVIEW_SECURITY_MODEL: "sonnet",
		MDW_REVIEW_SECURITY_BILLING: "api",
		MDW_REVIEW_ARCHITECTURE_PROVIDER: "agy",
		MDW_REVIEW_ARCHITECTURE_MODEL: "gemini-4-neon-medium",
		MDW_ANTHROPIC_API_KEY: "test-key",
		AWF_ANTHROPIC_API_KEY: "old-key",
		OPENAI_API_KEY: "other",
		GEMINI_API_KEY: "other-gemini",
	});
	const list = JSON.parse(
		command("mise", ["tasks", "ls", "--json"], { cwd, env }),
	);
	const entries = new Map(list.map((item) => [item.name, item]));
	for (const name of [
		"mdw:check",
		"mdw:review",
		"mdw:review:prepare",
		"mdw:review:check",
		"mdw:review:security",
		"mdw:review:architecture",
		"mdw:review:quality",
	])
		assert.ok(entries.has(name));
	for (const name of [
		"mdw:review",
		"mdw:review:check",
		"mdw:review:security",
		"mdw:review:architecture",
		"mdw:review:quality",
	]) {
		assert.deepEqual(entries.get(name).depends, []);
	}
	assert.ok(![...entries.keys()].some((name) => name.startsWith("mdw:_lib:")));
	const help = command("mise", ["run", "mdw:review", "--help"], { cwd, env });
	assert.match(help, /--base <ref>/);
	assert.match(help, /--head <ref>/);
	command("mise", ["run", "mdw:review", "--base", base, "--head", head], {
		cwd,
		env,
	});
	let merged = JSON.parse(
		fs.readFileSync(path.join(root, ".reviews/merged.json"), "utf8"),
	);
	assert.equal(merged.target.base_commit, base);
	assert.equal(merged.target.base_ref, base);
	assert.equal(merged.target.head_ref, head);
	assert.deepEqual(merged.reviews.map((item) => item.reviewer_id).sort(), [
		"architecture",
		"quality",
		"security",
	]);
	assert.equal(
		merged.reviews.find((item) => item.reviewer_id === "security").provider,
		"claude",
	);
	assert.equal(
		merged.reviews.find((item) => item.reviewer_id === "security").model,
		"sonnet",
	);
	assert.equal(
		merged.reviews.find((item) => item.reviewer_id === "architecture").provider,
		"agy",
	);
	assert.equal(
		merged.reviews.find((item) => item.reviewer_id === "architecture").model,
		"gemini-4-neon-medium",
	);
	assert.equal(
		merged.reviews.find((item) => item.reviewer_id === "quality").provider,
		"codex",
	);
	assert.equal(
		merged.reviews.find((item) => item.reviewer_id === "quality").model,
		null,
	);
	assert.ok(merged.duration_seconds >= 0);
	const resetControl = () => {
		for (const name of ["codex", "claude", "agy"])
			fs.rmSync(path.join(control, name), { force: true });
	};
	resetControl();
	command("mise", ["run", "mdw:review"], { cwd, env });
	merged = JSON.parse(
		fs.readFileSync(path.join(root, ".reviews/merged.json"), "utf8"),
	);
	assert.equal(merged.target.base_commit, base);
	assert.equal(merged.target.base_ref, "main");
	assert.equal(merged.target.head_ref, "HEAD");
	resetControl();
	const failed = spawnSync("mise", ["run", "mdw:review"], {
		cwd,
		env: { ...env, TEST_FAIL_REVIEW: "claude" },
		encoding: "utf8",
	});
	assert.equal(failed.status, 1, failed.stderr);
	assert.match(failed.stderr, /終了コード 12/);
	assert.ok(fs.existsSync(path.join(root, ".reviews/quality.json")));
	assert.ok(fs.existsSync(path.join(root, ".reviews/architecture.json")));
	assert.ok(!fs.existsSync(path.join(root, ".reviews/merged.json")));
	resetControl();
	env.TEST_BASE = base;
	env.TEST_HEAD = head;
	const library = pathToFileURL(path.join(tasks, "mdw/_lib/review.mts")).href;
	command(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			"import { run } from " +
				JSON.stringify(library) +
				'; const result = await run({baseRef: process.env.TEST_BASE, headRef: process.env.TEST_HEAD}); if (result.reviews.length !== 3) throw new Error("invalid result");',
		],
		{ cwd, env },
	);
	merged = JSON.parse(
		fs.readFileSync(path.join(root, ".reviews/merged.json"), "utf8"),
	);
	assert.equal(merged.target.base_commit, base);
	assert.equal(merged.target.head_ref, head);
	env.TEST_SOLO = "1";
	command(
		"mise",
		["run", "mdw:review:security", "--base", base, "--head", head],
		{ cwd, env },
	);
	assert.ok(fs.existsSync(path.join(root, ".reviews/security.json")));
	assert.ok(!fs.existsSync(path.join(root, ".reviews/architecture.json")));
	assert.ok(!fs.existsSync(path.join(root, ".reviews/quality.json")));
	assert.ok(!fs.existsSync(path.join(root, ".reviews/merged.json")));
	let manifest = JSON.parse(
		fs.readFileSync(path.join(root, ".reviews/manifest.json"), "utf8"),
	);
	assert.equal(manifest.base_ref, base);
	assert.equal(manifest.head_ref, head);
	command(
		"mise",
		["run", "mdw:review:architecture", "--base", base, "--head", head],
		{ cwd, env },
	);
	assert.ok(fs.existsSync(path.join(root, ".reviews/architecture.json")));
	assert.ok(!fs.existsSync(path.join(root, ".reviews/security.json")));
	assert.ok(!fs.existsSync(path.join(root, ".reviews/quality.json")));
	command(
		"mise",
		["run", "mdw:review:quality", "--base", base, "--head", head],
		{
			cwd,
			env: {
				...env,
				MDW_REVIEW_SECURITY_PROVIDER: "invalid",
				MDW_REVIEW_ARCHITECTURE_PROVIDER: "invalid",
			},
		},
	);
	assert.ok(fs.existsSync(path.join(root, ".reviews/quality.json")));
	assert.ok(!fs.existsSync(path.join(root, ".reviews/security.json")));
	assert.ok(!fs.existsSync(path.join(root, ".reviews/architecture.json")));
	command(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			"import { runRole } from " +
				JSON.stringify(library) +
				'; const result = await runRole("architecture", {baseRef: process.env.TEST_BASE, headRef: process.env.TEST_HEAD}); if (result.reviewer_id !== "architecture") throw new Error("invalid role result");',
		],
		{
			cwd,
			env: {
				...env,
				MDW_REVIEW_SECURITY_PROVIDER: "invalid",
				MDW_REVIEW_QUALITY_PROVIDER: "invalid",
			},
		},
	);
	assert.ok(fs.existsSync(path.join(root, ".reviews/architecture.json")));
	resetControl();
	const archPromptPath = path.join(tasks, "mdw/prompts/review/architecture.md");
	const savedArchPrompt = fs.readFileSync(archPromptPath, "utf8");
	fs.rmSync(archPromptPath);
	try {
		const missingPrompt = spawnSync(
			"mise",
			["run", "mdw:review", "--base", base, "--head", head],
			{ cwd, env: { ...env, TEST_SOLO: "0" }, encoding: "utf8" },
		);
		assert.equal(missingPrompt.status, 1);
		assert.match(missingPrompt.stderr, /読み取れません: architecture\.md/);
		for (const name of ["codex", "claude", "agy"])
			assert.ok(!fs.existsSync(path.join(control, name)));
	} finally {
		fs.writeFileSync(archPromptPath, savedArchPrompt);
	}
	command("mise", ["run", "mdw:review:check"], { cwd, env });
	assert.ok(fs.existsSync(path.join(root, ".reviews/architecture.json")));
	command(
		"mise",
		["run", "mdw:review:prepare", "--base", base, "--head", head],
		{ cwd, env },
	);
	manifest = JSON.parse(
		fs.readFileSync(path.join(root, ".reviews/manifest.json"), "utf8"),
	);
	assert.equal(manifest.base_ref, base);
	assert.equal(manifest.head_ref, head);
	const invalid = spawnSync(
		"mise",
		["run", "mdw:review:prepare", "--base", " "],
		{ cwd, env, encoding: "utf8" },
	);
	assert.notEqual(invalid.status, 0);
	assert.deepEqual(
		JSON.parse(
			fs.readFileSync(path.join(root, ".reviews/manifest.json"), "utf8"),
		),
		manifest,
	);
});
