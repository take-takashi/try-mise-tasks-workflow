import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	buildFixPrompt,
	isProtectedPath,
	parseGithubRepoFromRemote,
	partitionThreadsForAutoFix,
	resolveLinkedIssueNumber,
	resolveMaxIterations,
	resolveVerifyCommand,
	validateFixPlan,
	verificationEnvironment,
} from "../.mise/tasks/mdw/_lib/review-fix.mts";

const project = fileURLToPath(new URL("..", import.meta.url));
const pr = "https://github.com/example/project/pull/55";

function fixture(t, { branch = "feat/25-sample", prBody = "Closes #25" } = {}) {
	const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdw-review-fix-"));
	t.after(() => fs.rmSync(baseDir, { recursive: true, force: true }));
	const remoteDir = path.join(baseDir, "origin.git");
	const repoDir = path.join(baseDir, "repo");
	const bin = path.join(baseDir, "bin");
	const stateFile = path.join(baseDir, "state.json");
	fs.mkdirSync(remoteDir);
	fs.mkdirSync(repoDir);
	fs.mkdirSync(bin);

	const runGit = (cwd, ...args) => {
		const res = spawnSync("git", args, { cwd, encoding: "utf8" });
		assert.equal(res.status, 0, res.stderr || String(res.error));
		return res.stdout.trim();
	};

	runGit(remoteDir, "init", "--bare", "-b", "main");
	runGit(repoDir, "init", "-b", "main");
	runGit(repoDir, "config", "commit.gpgsign", "false");
	runGit(repoDir, "config", "user.name", "Test User");
	runGit(repoDir, "config", "user.email", "test@example.invalid");
	runGit(
		repoDir,
		"remote",
		"add",
		"origin",
		"https://github.com/example/project.git",
	);
	runGit(repoDir, "remote", "set-url", "--push", "origin", remoteDir);

	fs.cpSync(
		path.join(project, ".mise/tasks/mdw"),
		path.join(repoDir, ".mise/tasks/mdw"),
		{ recursive: true },
	);
	fs.writeFileSync(path.join(repoDir, "app.txt"), "before\n");
	runGit(repoDir, "add", ".");
	runGit(repoDir, "commit", "-m", "initial");
	runGit(repoDir, "push", "origin", "main");
	runGit(repoDir, "switch", "-c", branch);
	fs.writeFileSync(path.join(repoDir, "app.txt"), "needs-fix\n");
	runGit(repoDir, "commit", "-am", "feature change");
	runGit(repoDir, "push", "origin", branch);
	const headSha = runGit(repoDir, "rev-parse", "HEAD");
	const baseSha = runGit(repoDir, "rev-parse", "main");

	const readState = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));
	const writeState = (data) =>
		fs.writeFileSync(stateFile, JSON.stringify(data));
	writeState({
		prBody,
		baseSha,
		headSha,
		headRef: branch,
		threads: [
			{
				id: "PRRT_1",
				isResolved: false,
				isOutdated: false,
				path: "app.txt",
				line: 1,
				originalLine: 1,
				comments: {
					pageInfo: { hasNextPage: false },
					nodes: [
						{
							id: "PRRC_1",
							databaseId: 1,
							body: "app.txt を fixed に直してください",
							createdAt: "2026-11-26T00:00:00Z",
							url: `${pr}#discussion_r1`,
							authorAssociation: "OWNER",
							author: { login: "reviewer" },
						},
					],
				},
			},
		],
		replies: [],
		resolvedIds: [],
		labels: [],
		aiCalls: 0,
		aiScript: {
			mode: "fix-all",
		},
	});

	fs.writeFileSync(
		path.join(bin, "gh"),
		[
			"#!/usr/bin/env node",
			"const fs = require('node:fs');",
			"const { spawnSync } = require('node:child_process');",
			"const file = process.env.TEST_FIX_STATE;",
			"const state = JSON.parse(fs.readFileSync(file, 'utf8'));",
			"const args = process.argv.slice(2);",
			"if (args[0] !== 'api' || args[1] !== '--hostname' || args[2] !== 'github.com') process.exit(12);",
			"if (args[3] === 'repos/example/project/pulls/55') {",
			"  const remoteHead = spawnSync('git', ['rev-parse', state.headRef], { cwd: process.env.TEST_REMOTE_DIR, encoding: 'utf8' });",
			"  const currentHead = remoteHead.status === 0 ? remoteHead.stdout.trim() : state.headSha;",
			`  console.log(JSON.stringify({ html_url: ${JSON.stringify(pr)}, state: 'open', body: state.prBody, base: { sha: state.baseSha }, head: { sha: currentHead, ref: state.headRef } }));`,
			"  process.exit(0);",
			"}",
			"const labelMatch = /^repos\\/example\\/project\\/issues\\/(\\d+)\\/labels$/.exec(args[3]);",
			"if (labelMatch && args.includes('POST')) {",
			"  if (state.failLabel) { console.log(JSON.stringify({ status: '403', message: 'Forbidden' })); process.exit(1); }",
			"  const input = JSON.parse(fs.readFileSync(0, 'utf8'));",
			"  state.labels.push({ issue: Number(labelMatch[1]), labels: input.labels });",
			"  fs.writeFileSync(file, JSON.stringify(state));",
			"  console.log(JSON.stringify(input.labels.map((name) => ({ name }))));",
			"  process.exit(0);",
			"}",
			"if (args[3] !== 'graphql') process.exit(13);",
			"const payload = JSON.parse(fs.readFileSync(0, 'utf8'));",
			"if (payload.query.includes('reviewThreads')) {",
			"  console.log(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: state.threads } } } } }));",
			"  process.exit(0);",
			"}",
			"if (payload.query.includes('addPullRequestReviewThreadReply')) {",
			"  const { threadId, body } = payload.variables;",
			"  if (state.failReplyThreadId && state.failReplyThreadId === threadId) { console.log(JSON.stringify({ errors: [{ type: 'SERVICE_UNAVAILABLE', message: 'temporary failure' }] })); process.exit(1); }",
			"  const id = 'PRRC_reply_' + (state.replies.length + 1);",
			`  const url = ${JSON.stringify(`${pr}#discussion_r800`)} + (state.replies.length + 1);`,
			"  state.replies.push({ threadId, body, id, url });",
			"  const target = state.threads.find((item) => item.id === threadId);",
			"  if (target) target.comments.nodes.push({ id, databaseId: 800 + state.replies.length, body, createdAt: '2026-11-26T00:01:00Z', url, authorAssociation: 'OWNER', author: { login: 'bot' } });",
			"  fs.writeFileSync(file, JSON.stringify(state));",
			"  console.log(JSON.stringify({ data: { addPullRequestReviewThreadReply: { comment: { id, url } } } }));",
			"  process.exit(0);",
			"}",
			"if (payload.query.includes('resolveReviewThread')) {",
			"  const { threadId } = payload.variables;",
			"  state.resolvedIds.push(threadId);",
			"  const target = state.threads.find((item) => item.id === threadId);",
			"  if (target) target.isResolved = true;",
			"  if (state.spawnThreadAfterResolve) {",
			"    state.threads.push(state.spawnThreadAfterResolve);",
			"    state.spawnThreadAfterResolve = null;",
			"  }",
			"  fs.writeFileSync(file, JSON.stringify(state));",
			"  console.log(JSON.stringify({ data: { resolveReviewThread: { thread: { id: threadId, isResolved: true } } } }));",
			"  process.exit(0);",
			"}",
			"process.exit(14);",
		].join("\n"),
		{ mode: 0o755 },
	);

	fs.writeFileSync(
		path.join(bin, "agy"),
		[
			"#!/usr/bin/env node",
			"const fs = require('node:fs');",
			"const path = require('node:path');",
			"const args = process.argv.slice(2);",
			"if (args[0] === 'models') { console.log('gemini-4-neon-medium Gemini 4 Neon'); process.exit(0); }",
			"const file = process.env.TEST_FIX_STATE;",
			"const state = JSON.parse(fs.readFileSync(file, 'utf8'));",
			"state.aiCalls += 1;",
			"fs.readFileSync(0, 'utf8');",
			"const mode = state.aiScript.mode;",
			"let output;",
			"if (mode === 'fix-all') {",
			"  fs.writeFileSync(path.join(process.cwd(), 'app.txt'), 'fixed-' + state.aiCalls + '\\n');",
			"  const openIds = state.threads.filter((item) => !item.isResolved).map((item) => item.id);",
			"  output = { commit_message: 'fix: レビュー指摘を修正する', results: openIds.map((id) => ({ thread_id: id, status: 'fixed', summary: 'app.txt を修正しました @mention' })) };",
			"} else if (mode === 'mixed') {",
			"  fs.writeFileSync(path.join(process.cwd(), 'app.txt'), 'fixed-mixed\\n');",
			"  output = { commit_message: 'fix: 1件目を修正する', results: [{ thread_id: 'PRRT_1', status: 'fixed', summary: 'app.txt を修正しました' }, { thread_id: 'PRRT_2', status: 'needs_human', summary: '仕様判断が必要です' }] };",
			"} else if (mode === 'no-edit-but-fixed') {",
			"  output = { commit_message: 'fix: 編集なし', results: [{ thread_id: 'PRRT_1', status: 'fixed', summary: '直したつもり' }] };",
			"} else if (mode === 'out-of-scope-edit') {",
			"  fs.writeFileSync(path.join(process.cwd(), 'app.txt'), 'fixed-1\\n');",
			"  fs.writeFileSync(path.join(process.cwd(), 'extra.txt'), 'injected\\n');",
			"  output = { commit_message: 'fix: 範囲外も変更', results: [{ thread_id: 'PRRT_1', status: 'fixed', summary: '修正' }] };",
			"} else if (mode === 'test-file-edit') {",
			"  fs.writeFileSync(path.join(process.cwd(), 'tests/sample.test.mts'), 'changed\\n');",
			"  output = { commit_message: 'fix: テスト修正', results: [{ thread_id: 'PRRT_TEST', status: 'fixed', summary: 'テスト修正' }] };",
			"}",
			"fs.writeFileSync(file, JSON.stringify(state));",
			"console.log(JSON.stringify({ status: 'SUCCESS', structured_output: output, denied_actions: [] }));",
		].join("\n"),
		{ mode: 0o755 },
	);

	const env = Object.fromEntries(
		Object.entries(process.env).filter(
			([key]) =>
				!key.startsWith("MDW_") &&
				!key.startsWith("AWF_") &&
				key !== "MISE_ORIGINAL_CWD",
		),
	);
	Object.assign(env, {
		PATH: `${bin}${path.delimiter}${env.PATH}`,
		MDW_DEFAULT_PROVIDER: "agy",
		TEST_FIX_STATE: stateFile,
		TEST_REMOTE_DIR: remoteDir,
	});
	const run = (extraEnv = {}, ...args) =>
		spawnSync(args[0], args.slice(1), {
			cwd: repoDir,
			env: { ...env, ...extraEnv },
			encoding: "utf8",
		});
	return { repoDir, remoteDir, run, runGit, readState, writeState };
}

test("review-fix の設定・Issue 解決・プロンプト順序・計画検証を単体検証する", () => {
	assert.equal(resolveMaxIterations(undefined), 1);
	assert.equal(resolveMaxIterations("3"), 3);
	assert.throws(() => resolveMaxIterations("0"), /1〜5/);
	assert.throws(() => resolveMaxIterations("6"), /1〜5/);
	assert.throws(() => resolveMaxIterations("abc"), /1〜5/);

	assert.equal(resolveVerifyCommand(undefined, {}), null);
	assert.equal(
		resolveVerifyCommand(undefined, { MDW_REVIEW_FIX_VERIFY: "npm test" }),
		"npm test",
	);
	assert.equal(resolveVerifyCommand("mise run check", {}), "mise run check");
	assert.throws(() => resolveVerifyCommand("  ", {}), /空でないコマンド/);

	assert.equal(
		resolveLinkedIssueNumber({
			explicitIssue: "42",
			prBody: "Closes #10",
			branchName: "feat/11-x",
		}),
		42,
	);
	assert.equal(
		resolveLinkedIssueNumber({ prBody: "Fixes #18", branchName: "feat/99-x" }),
		18,
	);
	assert.equal(
		resolveLinkedIssueNumber({ prBody: "no link", branchName: "feat/25-fix" }),
		25,
	);
	assert.equal(
		resolveLinkedIssueNumber({ prBody: "", branchName: "chore/no-number" }),
		null,
	);
	assert.throws(
		() => resolveLinkedIssueNumber({ explicitIssue: "0" }),
		/正の整数/,
	);

	assert.deepEqual(
		parseGithubRepoFromRemote("https://github.com/Owner/Repo.git"),
		{ owner: "Owner", repo: "Repo" },
	);
	assert.deepEqual(parseGithubRepoFromRemote("git@github.com:Owner/Repo.git"), {
		owner: "Owner",
		repo: "Repo",
	});
	assert.deepEqual(
		parseGithubRepoFromRemote("ssh://git@github.com/Owner/Repo"),
		{ owner: "Owner", repo: "Repo" },
	);
	assert.equal(parseGithubRepoFromRemote("https://example.invalid/a/b"), null);

	const prompt = buildFixPrompt(
		{ url: pr, headRef: "feat/25-sample", headSha: "a".repeat(40) },
		[{ id: "PRRT_1" }],
	);
	const staticGuide = fs
		.readFileSync(
			path.join(project, ".mise/tasks/mdw/prompts/review/fix.md"),
			"utf8",
		)
		.trim();
	assert.ok(prompt.startsWith(`${staticGuide}\n\n## 修正対象`));

	assert.throws(
		() =>
			validateFixPlan(
				{
					commit_message: "fix: ok",
					results: [{ thread_id: "UNKNOWN", status: "fixed", summary: "x" }],
				},
				[{ id: "PRRT_1" }],
			),
		/未知のスレッド ID/,
	);
	assert.throws(
		() =>
			validateFixPlan(
				{
					commit_message: "line1\nline2",
					results: [{ thread_id: "PRRT_1", status: "fixed", summary: "x" }],
				},
				[{ id: "PRRT_1" }],
			),
		/1 行の有効な commit_message/,
	);

	assert.equal(isProtectedPath(".github/workflows/ci.yml"), true);
	assert.equal(isProtectedPath(".mdw/models.env"), true);
	assert.equal(isProtectedPath("mise.toml"), true);
	assert.equal(isProtectedPath("mise.local.toml"), true);
	assert.equal(isProtectedPath(".env.production"), true);
	assert.equal(isProtectedPath("../outside.txt"), true);
	assert.equal(isProtectedPath("app.txt"), false);

	const partitioned = partitionThreadsForAutoFix([
		{
			id: "T_OK",
			path: "app.txt",
			line: 1,
			comments_truncated: false,
			comments: [{ author_association: "OWNER" }],
		},
		{
			id: "T_UNTRUSTED",
			path: "app.txt",
			line: 2,
			comments_truncated: false,
			comments: [
				{ author_association: "OWNER" },
				{ author_association: "NONE" },
			],
		},
		{
			id: "T_TRUNC",
			path: "app.txt",
			line: 3,
			comments_truncated: true,
			comments: [{ author_association: "OWNER" }],
		},
		{
			id: "T_PROTECTED",
			path: ".github/workflows/ci.yml",
			line: 4,
			comments_truncated: false,
			comments: [{ author_association: "MEMBER" }],
		},
	]);
	assert.deepEqual(
		partitioned.fixableThreads.map((t) => t.id),
		["T_OK"],
	);
	assert.deepEqual(
		partitioned.skippedThreads.map((t) => [t.id, t.reason]),
		[
			["T_UNTRUSTED", "untrusted_author"],
			["T_TRUNC", "untrusted_author"],
			["T_PROTECTED", "protected_path"],
		],
	);

	const verifyEnv = verificationEnvironment({
		PATH: "/usr/bin",
		GH_TOKEN: "secret-gh",
		OPENAI_API_KEY: "secret-oa",
		CUSTOM_APP_SECRET: "secret-custom",
		NORMAL_VAR: "ok",
	});
	assert.equal(verifyEnv.PATH, "/usr/bin");
	assert.equal(verifyEnv.NORMAL_VAR, "ok");
	assert.equal("GH_TOKEN" in verifyEnv, false);
	assert.equal("OPENAI_API_KEY" in verifyEnv, false);
	assert.equal("CUSTOM_APP_SECRET" in verifyEnv, false);
});

test("mdw:review:fix が未解決スレッドを修正・検証・プッシュ・返信＆resolve まで完走する", (t) => {
	const f = fixture(t);

	// --dry-run は変更も外部書き込みも行わない
	const dryRes = f.run(
		{},
		"mise",
		"run",
		"mdw:review:fix",
		"--pr",
		pr,
		"--verify",
		"test -f app.txt",
		"--dry-run",
	);
	assert.equal(dryRes.status, 0, dryRes.stderr);
	const dryJson = JSON.parse(dryRes.stdout);
	assert.equal(dryJson.status, "dry_run");
	assert.equal(dryJson.issue_number, 25);
	assert.equal(dryJson.unresolved_threads.length, 1);
	assert.equal(f.readState().aiCalls, 0);
	assert.equal(f.readState().replies.length, 0);

	// 本番実行：修正 → 検証（秘密情報除外＆副作用ファイル未ステージ） → コミット＆プッシュ → 返信＆resolve
	const runRes = f.run(
		{ GH_TOKEN: "must-not-leak", CUSTOM_SECRET: "must-not-leak" },
		"mise",
		"run",
		"mdw:review:fix",
		"--pr",
		pr,
		"--verify",
		'test -z "$GH_TOKEN" && test -z "$CUSTOM_SECRET" && echo temp > verify-side-effect.tmp && grep -q fixed-1 app.txt',
	);
	assert.equal(runRes.status, 0, runRes.stderr);
	const result = JSON.parse(runRes.stdout);
	assert.equal(result.status, "completed");
	assert.equal(result.remaining_threads, 0);
	assert.equal(result.wait_label.labeled, false);
	assert.equal(result.iterations.length, 1);
	const commitSha = result.iterations[0].commit_sha;
	assert.match(commitSha, /^[0-9a-f]{40}$/);
	assert.equal(f.runGit(f.remoteDir, "rev-parse", "feat/25-sample"), commitSha);
	assert.equal(
		f.runGit(f.repoDir, "show", "--pretty=format:", "--name-only", commitSha),
		"app.txt",
	);
	assert.equal(
		fs.existsSync(path.join(f.repoDir, "verify-side-effect.tmp")),
		true,
	);
	fs.rmSync(path.join(f.repoDir, "verify-side-effect.tmp"));
	const state = f.readState();
	assert.equal(state.replies.length, 1);
	assert.match(state.replies[0].body, new RegExp(commitSha.slice(0, 7)));
	assert.match(
		state.replies[0].body,
		/~~~\napp\.txt を修正しました @mention\n~~~/,
	);
	assert.deepEqual(state.resolvedIds, ["PRRT_1"]);
	assert.deepEqual(state.labels, []);

	// 未解決スレッド 0 件時は AI を起動せず即終了する
	const emptyRes = f.run({}, "mise", "run", "mdw:review:fix", "--pr", pr);
	assert.equal(emptyRes.status, 0, emptyRes.stderr);
	assert.equal(JSON.parse(emptyRes.stdout).status, "no_unresolved_threads");
	assert.equal(f.readState().aiCalls, 1);
});

test("混在ケース（fixed + needs_human）と上限到達時に未解決スレッドを残し mdw:wait を付与する", (t) => {
	const f = fixture(t);
	const state = f.readState();
	state.threads.push({
		id: "PRRT_2",
		isResolved: false,
		isOutdated: false,
		path: "app.txt",
		line: 1,
		originalLine: 1,
		comments: {
			pageInfo: { hasNextPage: false },
			nodes: [
				{
					id: "PRRC_2",
					databaseId: 2,
					body: "設計方針を選んでください",
					createdAt: "2026-11-26T00:00:00Z",
					url: `${pr}#discussion_r2`,
					authorAssociation: "COLLABORATOR",
					author: { login: "reviewer" },
				},
			],
		},
	});
	state.aiScript = { mode: "mixed" };
	f.writeState(state);

	const res = f.run({}, "mise", "run", "mdw:review:fix", "--pr", pr);
	assert.equal(res.status, 0, res.stderr);
	const json = JSON.parse(res.stdout);
	assert.equal(json.status, "needs_human");
	assert.equal(json.remaining_threads, 1);
	assert.deepEqual(json.wait_label, { labeled: true, issue_number: 25 });
	const after = f.readState();
	assert.deepEqual(after.resolvedIds, ["PRRT_1"]);
	assert.equal(after.replies.length, 2);
	assert.match(after.replies[1].body, /自動修正を保留しました/);
	assert.deepEqual(after.labels, [{ issue: 25, labels: ["mdw:wait"] }]);

	// 上限到達ケース（--max-iterations 1 後に新スレッドが残る）
	const f2 = fixture(t);
	const s2 = f2.readState();
	s2.spawnThreadAfterResolve = {
		id: "PRRT_new",
		isResolved: false,
		isOutdated: false,
		path: "app.txt",
		line: 1,
		originalLine: 1,
		comments: {
			pageInfo: { hasNextPage: false },
			nodes: [
				{
					id: "PRRC_new",
					databaseId: 3,
					body: "追加の指摘です",
					createdAt: "2026-11-26T00:02:00Z",
					url: `${pr}#discussion_r3`,
					authorAssociation: "OWNER",
					author: { login: "reviewer" },
				},
			],
		},
	};
	f2.writeState(s2);
	const maxRes = f2.run(
		{},
		"mise",
		"run",
		"mdw:review:fix",
		"--pr",
		pr,
		"--max-iterations",
		"1",
	);
	assert.equal(maxRes.status, 0, maxRes.stderr);
	const maxJson = JSON.parse(maxRes.stdout);
	assert.equal(maxJson.status, "max_iterations_reached");
	assert.equal(maxJson.remaining_threads, 1);
	assert.deepEqual(f2.readState().labels, [
		{ issue: 25, labels: ["mdw:wait"] },
	]);
});

test("検証失敗・差分なし矛盾・プッシュ障害・事前ガード違反で誤って resolve しない", (t) => {
	// 1. 検証コマンド失敗時はコミット・プッシュ・resolve せず mdw:wait を付与する
	const fVerify = fixture(t);
	const beforeHead = fVerify.runGit(fVerify.repoDir, "rev-parse", "HEAD");
	const verifyFail = fVerify.run(
		{},
		"mise",
		"run",
		"mdw:review:fix",
		"--pr",
		pr,
		"--verify",
		"exit 2",
	);
	assert.equal(verifyFail.status, 1);
	assert.match(verifyFail.stderr, /検証コマンドが終了コード 2 で失敗/);
	assert.equal(
		fVerify.runGit(fVerify.repoDir, "rev-parse", "HEAD"),
		beforeHead,
	);
	assert.equal(fVerify.readState().replies.length, 0);
	assert.equal(fVerify.readState().resolvedIds.length, 0);
	assert.deepEqual(fVerify.readState().labels, [
		{ issue: 25, labels: ["mdw:wait"] },
	]);

	// 2. AI が fixed を返したのに差分がない場合は拒否する
	const fNoEdit = fixture(t);
	fNoEdit.writeState({
		...fNoEdit.readState(),
		aiScript: { mode: "no-edit-but-fixed" },
	});
	const noEditFail = fNoEdit.run(
		{},
		"mise",
		"run",
		"mdw:review:fix",
		"--pr",
		pr,
	);
	assert.equal(noEditFail.status, 1);
	assert.match(noEditFail.stderr, /作業ツリーに変更がありません/);
	assert.equal(fNoEdit.readState().resolvedIds.length, 0);

	// 3. プッシュ失敗時は未プッシュのまま resolve しない
	const fPush = fixture(t);
	fPush.runGit(
		fPush.repoDir,
		"remote",
		"set-url",
		"--push",
		"origin",
		path.join(fPush.repoDir, "nonexistent-remote.git"),
	);
	const pushFail = fPush.run({}, "mise", "run", "mdw:review:fix", "--pr", pr);
	assert.equal(pushFail.status, 1);
	assert.match(
		pushFail.stderr,
		/プッシュに失敗したため resolve を中断しました/,
	);
	assert.equal(fPush.readState().replies.length, 0);
	assert.equal(fPush.readState().resolvedIds.length, 0);

	// 4. 未コミット変更・ブランチ不一致・別リポジトリ origin を事前拒否する
	const fDirty = fixture(t);
	fs.writeFileSync(path.join(fDirty.repoDir, "app.txt"), "dirty\n");
	const dirtyRes = fDirty.run({}, "mise", "run", "mdw:review:fix", "--pr", pr);
	assert.equal(dirtyRes.status, 1);
	assert.match(dirtyRes.stderr, /未コミットの変更があります/);

	const fWrongBranch = fixture(t);
	fWrongBranch.runGit(fWrongBranch.repoDir, "switch", "main");
	const branchRes = fWrongBranch.run(
		{},
		"mise",
		"run",
		"mdw:review:fix",
		"--pr",
		pr,
	);
	assert.equal(branchRes.status, 1);
	assert.match(branchRes.stderr, /ヘッドブランチ.*一致しません/);

	const fWrongOrigin = fixture(t);
	fWrongOrigin.runGit(
		fWrongOrigin.repoDir,
		"remote",
		"set-url",
		"origin",
		"https://github.com/other/repo.git",
	);
	const originRes = fWrongOrigin.run(
		{},
		"mise",
		"run",
		"mdw:review:fix",
		"--pr",
		pr,
	);
	assert.equal(originRes.status, 1);
	assert.match(
		originRes.stderr,
		/origin が指定された Pull Request のリポジトリと一致しません/,
	);
});

test("信頼境界・範囲外変更・テスト変更時の検証停止・部分失敗復旧・ラベル付与失敗耐性を検証する", (t) => {
	// 1. 権限外の投稿者や保護対象パスだけのスレッドは AI を呼ばず needs_human と mdw:wait にする
	const fUntrusted = fixture(t);
	const sUntrusted = fUntrusted.readState();
	sUntrusted.threads[0].comments.nodes[0].authorAssociation = "NONE";
	sUntrusted.threads.push({
		id: "PRRT_CI",
		isResolved: false,
		isOutdated: false,
		path: ".github/workflows/ci.yml",
		line: 1,
		originalLine: 1,
		comments: {
			pageInfo: { hasNextPage: false },
			nodes: [
				{
					id: "PRRC_CI",
					databaseId: 9,
					body: "CI を書き換えてください",
					createdAt: "2026-11-26T00:00:00Z",
					url: `${pr}#discussion_r9`,
					authorAssociation: "OWNER",
					author: { login: "owner" },
				},
			],
		},
	});
	fUntrusted.writeState(sUntrusted);
	const untrustedRes = fUntrusted.run(
		{},
		"mise",
		"run",
		"mdw:review:fix",
		"--pr",
		pr,
	);
	assert.equal(untrustedRes.status, 0, untrustedRes.stderr);
	const untrustedJson = JSON.parse(untrustedRes.stdout);
	assert.equal(untrustedJson.status, "needs_human");
	assert.equal(fUntrusted.readState().aiCalls, 0);
	assert.deepEqual(
		untrustedJson.skipped_threads.map((item) => [item.id, item.reason]),
		[
			["PRRT_1", "untrusted_author"],
			["PRRT_CI", "protected_path"],
		],
	);
	assert.deepEqual(fUntrusted.readState().labels, [
		{ issue: 25, labels: ["mdw:wait"] },
	]);

	// 2. AI が対象スレッド外の新規ファイルを作成した場合は検証コマンド実行前に中断する
	const fScope = fixture(t);
	fScope.writeState({
		...fScope.readState(),
		aiScript: { mode: "out-of-scope-edit" },
	});
	const scopeRes = fScope.run(
		{},
		"mise",
		"run",
		"mdw:review:fix",
		"--pr",
		pr,
		"--verify",
		"echo SHOULD_NOT_RUN > ran.txt",
	);
	assert.equal(scopeRes.status, 1);
	assert.match(scopeRes.stderr, /新規ファイルの追加（extra\.txt）/);
	assert.equal(fs.existsSync(path.join(fScope.repoDir, "ran.txt")), false);
	assert.deepEqual(fScope.readState().labels, [
		{ issue: 25, labels: ["mdw:wait"] },
	]);

	// 3. テストファイルが変更された場合は --verify を自動実行せず人間へ引き渡す
	const fTestEdit = fixture(t);
	fs.mkdirSync(path.join(fTestEdit.repoDir, "tests"), { recursive: true });
	fs.writeFileSync(
		path.join(fTestEdit.repoDir, "tests/sample.test.mts"),
		"before\n",
	);
	fTestEdit.runGit(fTestEdit.repoDir, "add", "tests/sample.test.mts");
	fTestEdit.runGit(fTestEdit.repoDir, "commit", "-m", "add test file");
	fTestEdit.runGit(fTestEdit.repoDir, "push", "origin", "feat/25-sample");
	const sTestEdit = fTestEdit.readState();
	sTestEdit.headSha = fTestEdit.runGit(fTestEdit.repoDir, "rev-parse", "HEAD");
	sTestEdit.threads = [
		{
			id: "PRRT_TEST",
			isResolved: false,
			isOutdated: false,
			path: "tests/sample.test.mts",
			line: 1,
			originalLine: 1,
			comments: {
				pageInfo: { hasNextPage: false },
				nodes: [
					{
						id: "PRRC_TEST",
						databaseId: 10,
						body: "テストを更新してください",
						createdAt: "2026-11-26T00:00:00Z",
						url: `${pr}#discussion_r10`,
						authorAssociation: "OWNER",
						author: { login: "owner" },
					},
				],
			},
		},
	];
	sTestEdit.aiScript = { mode: "test-file-edit" };
	fTestEdit.writeState(sTestEdit);
	const testEditRes = fTestEdit.run(
		{},
		"mise",
		"run",
		"mdw:review:fix",
		"--pr",
		pr,
		"--verify",
		"echo SHOULD_NOT_RUN > ran-test.txt",
	);
	assert.equal(testEditRes.status, 1);
	assert.match(
		testEditRes.stderr,
		/テスト・タスク・設定ファイルが変更されたため/,
	);
	assert.equal(
		fs.existsSync(path.join(fTestEdit.repoDir, "ran-test.txt")),
		false,
	);
	assert.deepEqual(fTestEdit.readState().labels, [
		{ issue: 25, labels: ["mdw:wait"] },
	]);

	// 4. プッシュ後の返信で部分失敗しても、プッシュ済み SHA と失敗詳細・復旧コマンドを JSON 出力する
	const fPartial = fixture(t);
	const sPartial = fPartial.readState();
	sPartial.threads.push({
		id: "PRRT_2",
		isResolved: false,
		isOutdated: false,
		path: "app.txt",
		line: 1,
		originalLine: 1,
		comments: {
			pageInfo: { hasNextPage: false },
			nodes: [
				{
					id: "PRRC_2",
					databaseId: 2,
					body: "2件目の指摘",
					createdAt: "2026-11-26T00:00:00Z",
					url: `${pr}#discussion_r2`,
					authorAssociation: "OWNER",
					author: { login: "owner" },
				},
			],
		},
	});
	sPartial.failReplyThreadId = "PRRT_2";
	fPartial.writeState(sPartial);
	const partialRes = fPartial.run(
		{},
		"mise",
		"run",
		"mdw:review:fix",
		"--pr",
		pr,
	);
	assert.equal(partialRes.status, 1);
	const partialJson = JSON.parse(partialRes.stdout);
	assert.equal(partialJson.status, "partial_failure");
	assert.match(partialJson.iterations[0].commit_sha, /^[0-9a-f]{40}$/);
	assert.equal(partialJson.iterations[0].replies.length, 1);
	assert.equal(partialJson.iterations[0].failed_replies.length, 1);
	assert.equal(partialJson.iterations[0].failed_replies[0].thread_id, "PRRT_2");
	assert.match(
		partialJson.iterations[0].failed_replies[0].recovery_command,
		/mdw:review:reply .*--thread PRRT_2 --resolve/,
	);
	assert.deepEqual(partialJson.wait_label, { labeled: true, issue_number: 25 });

	// 5. 終了時の mdw:wait ラベル付与が失敗しても完了済み結果 JSON を失わない
	const fLabelFail = fixture(t);
	const sLabelFail = fLabelFail.readState();
	sLabelFail.threads[0].comments.nodes[0].authorAssociation = "NONE";
	sLabelFail.failLabel = true;
	fLabelFail.writeState(sLabelFail);
	const labelFailRes = fLabelFail.run(
		{},
		"mise",
		"run",
		"mdw:review:fix",
		"--pr",
		pr,
	);
	assert.equal(labelFailRes.status, 0, labelFailRes.stderr);
	const labelFailJson = JSON.parse(labelFailRes.stdout);
	assert.equal(labelFailJson.status, "needs_human");
	assert.equal(labelFailJson.wait_label.labeled, false);
	assert.equal(labelFailJson.wait_label.issue_number, 25);
	assert.ok(labelFailJson.wait_label.error);
	assert.match(labelFailRes.stderr, /mdw:wait ラベル付与に失敗/);
});
