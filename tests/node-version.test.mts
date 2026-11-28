import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cli } from "../.mise/tasks/mdw/_lib/cli.mts";
import {
	assertSupportedNodeVersion,
	checkNodeVersion,
	isMainModule,
	parseNodeVersion,
	SUPPORTED_NODE_REQUIREMENT,
} from "../.mise/tasks/mdw/_lib/node-version.mts";

const mdwRoot = fileURLToPath(new URL("../.mise/tasks/mdw/", import.meta.url));

function collectPublicMdwTasks(directory: string, list: string[] = []) {
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		const fullPath = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "_lib" || entry.name === "prompts") continue;
			collectPublicMdwTasks(fullPath, list);
		} else if (entry.name.endsWith(".mts")) {
			list.push(fullPath);
		}
	}
	return list;
}

test("対応する Node.js バージョンを正しく判定する", () => {
	for (const version of [
		"22.18.0",
		"v22.18.0",
		"22.18.1",
		"22.22.0",
		"22.18.0+build.1",
		"22.18.1-rc.1",
		"22.19.0-beta.1",
		"24.2.0",
		"v24.22.3",
		"24.2.1-rc.1",
		"25.0.0",
		"25.0.0-rc.1",
		"26.1.0",
	]) {
		const result = checkNodeVersion(version);
		assert.equal(result.ok, true, version);
		assert.equal(result.reason, null);
		assert.equal(result.requirement, SUPPORTED_NODE_REQUIREMENT);
		assert.doesNotThrow(() => assertSupportedNodeVersion(version));
	}
});

test("非対応バージョンと境界値・不正入力を拒否し案内メッセージを返す", () => {
	for (const version of [
		"20.19.0",
		"21.7.3",
		"22.0.0",
		"22.17.99",
		"22.18.0-rc.1",
		"23.0.0",
		"23.99.0",
		"24.0.0",
		"24.1.99",
		"24.2.0-rc.1",
	]) {
		const result = checkNodeVersion(version);
		assert.equal(result.ok, false, version);
		assert.ok(result.reason?.includes(SUPPORTED_NODE_REQUIREMENT), version);
		assert.throws(
			() => assertSupportedNodeVersion(version),
			new RegExp(
				SUPPORTED_NODE_REQUIREMENT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
			),
		);
	}

	assert.match(checkNodeVersion("24.1.0").reason ?? "", /import\.meta\.main/);
	assert.match(checkNodeVersion("23.11.0").reason ?? "", /23 系/);

	for (const invalid of [
		"",
		"  ",
		"abc",
		"22.18",
		"v22.18.0.1",
		null,
		undefined,
	]) {
		assert.equal(parseNodeVersion(invalid), null);
		const result = checkNodeVersion(invalid);
		assert.equal(result.ok, false);
		assert.equal(result.version, null);
		assert.match(result.reason ?? "", /判別できません/);
	}
});

test("isMainModule は import.meta.main を優先し、未定義時はファイルパスで判別する", (t) => {
	assert.equal(
		isMainModule({ main: true, url: "file:///a.mts" }, ["node", "/b.mts"]),
		true,
	);
	assert.equal(
		isMainModule({ main: false, url: "file:///a.mts" }, ["node", "/a.mts"]),
		false,
	);

	const temp = fs.mkdtempSync(path.join(os.tmpdir(), "mdw-node-ver-test-"));
	t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
	const realFile = path.join(temp, "task.mts");
	const otherFile = path.join(temp, "other.mts");
	const linkFile = path.join(temp, "link.mts");
	fs.writeFileSync(realFile, "");
	fs.writeFileSync(otherFile, "");
	fs.symlinkSync(realFile, linkFile);

	const meta = { url: pathToFileURL(realFile).href };
	assert.equal(isMainModule(meta, ["node", realFile]), true);
	assert.equal(isMainModule(meta, ["node", linkFile]), true);
	assert.equal(isMainModule(meta, ["node", otherFile]), false);
	assert.equal(isMainModule(meta, ["node"]), false);
	assert.equal(
		isMainModule({ url: "https://example.invalid/a.mts" }, ["node", realFile]),
		false,
	);
});

test("cli() は非対応 Node.js バージョン時に action を実行せず終了コード 1 を設定する", async () => {
	let called = false;
	const errors: string[] = [];
	const originalError = console.error;
	const originalExitCode = process.exitCode;
	console.error = (...args) => {
		errors.push(args.map(String).join(" "));
	};
	process.exitCode = undefined;
	try {
		await cli(
			"テスト用コマンド",
			() => {
				called = true;
			},
			{ nodeVersion: "24.1.0" },
		);
		assert.equal(called, false);
		assert.equal(process.exitCode, 1);
		assert.match(errors.join("\n"), /import\.meta\.main/);
		assert.ok(errors.join("\n").includes(SUPPORTED_NODE_REQUIREMENT));
	} finally {
		console.error = originalError;
		process.exitCode = originalExitCode;
	}
});

test("全公開タスクが isMainModule とバージョン検証を経由し、非対応バージョンを拒否する", (t) => {
	const tasks = collectPublicMdwTasks(mdwRoot);
	assert.ok(tasks.length >= 17);
	for (const taskFile of tasks) {
		const source = fs.readFileSync(taskFile, "utf8");
		assert.equal(
			/if\s*\(\s*import\.meta\.main\s*\)/.test(source),
			false,
			`${taskFile} は isMainModule(import.meta) を使ってください`,
		);
		assert.match(
			source,
			/if\s*\(\s*isMainModule\(import\.meta\)\s*\)/,
			`${taskFile} に isMainModule(import.meta) がありません`,
		);
		assert.ok(
			/\bcli\s*\(/.test(source) ||
				/\bassertSupportedNodeVersion\s*\(/.test(source),
			`${taskFile} に Node.js バージョン検証の呼び出しがありません`,
		);
	}

	// 非対応バージョン（v24.1.0）を模擬した実プロセス実行で、cli() 経由と独自 try/catch 経由の両方が終了コード 1 で拒否されることを確認する。
	const temp = fs.mkdtempSync(path.join(os.tmpdir(), "mdw-node-e2e-test-"));
	t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
	const preload = path.join(temp, "fake-node-24-1.mjs");
	fs.writeFileSync(
		preload,
		'Object.defineProperty(process.versions, "node", { value: "24.1.0", configurable: true });\n',
	);

	for (const relativeTask of [
		"intent.mts",
		"interview.mts",
		"issue/new.mts",
		"worktree/new.mts",
		"worktree/cleanup.mts",
		"review/post.mts",
	]) {
		const taskPath = path.join(mdwRoot, relativeTask);
		const result = spawnSync(
			process.execPath,
			["--import", pathToFileURL(preload).href, taskPath],
			{ encoding: "utf8" },
		);
		assert.equal(result.status, 1, `${relativeTask}: ${result.stderr}`);
		assert.match(result.stderr, /v24\.1\.0/);
		assert.ok(result.stderr.includes(SUPPORTED_NODE_REQUIREMENT), relativeTask);
	}
});
