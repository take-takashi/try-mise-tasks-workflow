import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildIntentPrompt } from "../.mise/tasks/mdw/_lib/intent.mts";

const project = fileURLToPath(new URL("..", import.meta.url));

function fixture(t) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "mdw-intent-test-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	fs.cpSync(
		path.join(project, ".mise/tasks/mdw"),
		path.join(root, ".mise/tasks/mdw"),
		{ recursive: true },
	);
	fs.mkdirSync(path.join(root, "nested"));
	assert.equal(
		spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root }).status,
		0,
	);
	const env = {
		...process.env,
		MISE_YES: "1",
		MDW_DEFAULT_PROVIDER: "invalid",
		MDW_INTERVIEW_PROVIDER: "invalid",
	};
	delete env.MISE_ORIGINAL_CWD;
	const run = (...args) =>
		spawnSync("mise", args, {
			cwd: path.join(root, "nested"),
			env,
			encoding: "utf8",
		});
	return { root, run };
}

test("コピーした intent タスクは AI 設定なしで手順を出力し、ファイルを変更しない", (t) => {
	const { root, run } = fixture(t);
	const listing = run("tasks", "ls", "--json");
	assert.equal(listing.status, 0, listing.stderr);
	assert.ok(
		JSON.parse(listing.stdout).some(({ name }) => name === "mdw:intent"),
	);
	const help = run("run", "mdw:intent", "--help");
	assert.equal(help.status, 0, help.stderr);
	assert.match(help.stdout, /現在の会話/);
	const result = run("run", "mdw:intent");
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout.trim(), buildIntentPrompt().trim());
	assert.ok(!fs.existsSync(path.join(root, "docs")));
	fs.mkdirSync(path.join(root, "docs"));
	const intent = path.join(root, "docs/intent.md");
	fs.writeFileSync(intent, "# 既存の判断基準\n");
	assert.equal(run("run", "mdw:intent").status, 0);
	assert.equal(fs.readFileSync(intent, "utf8"), "# 既存の判断基準\n");
	assert.deepEqual(fs.readdirSync(path.join(root, "docs")), ["intent.md"]);
	assert.notEqual(run("run", "mdw:intent", "unexpected").status, 0);
});

test("共有する更新手順の変更は intent と interview の両方に一度だけ反映される", (t) => {
	const { root, run } = fixture(t);
	const file = path.join(root, ".mise/tasks/mdw/prompts/intent.md");
	const marker = "共有する更新ルールの追加を確認するための目印";
	fs.appendFileSync(file, `\n${marker}\n`);
	const shared = fs.readFileSync(file, "utf8").trim();
	const intent = run("run", "mdw:intent");
	const interview = run("run", "mdw:interview", "--prompt");
	assert.equal(intent.status, 0, intent.stderr);
	assert.equal(interview.status, 0, interview.stderr);
	assert.equal(intent.stdout.trim(), shared);
	assert.ok(interview.stdout.trim().endsWith(shared));
	assert.equal(interview.stdout.split(marker).length - 1, 1);
	assert.ok(
		interview.stdout.startsWith(
			fs
				.readFileSync(
					path.join(root, ".mise/tasks/mdw/prompts/interview.md"),
					"utf8",
				)
				.trimEnd(),
		),
	);
	assert.ok(!fs.existsSync(path.join(root, "docs")));
});
