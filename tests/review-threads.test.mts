import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const project = fileURLToPath(new URL("..", import.meta.url));
const pr = "https://github.com/example/project/pull/34";

function fixture(t) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "mdw-review-threads-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const bin = path.join(root, "bin");
	const stateFile = path.join(root, "state.json");
	fs.mkdirSync(bin);
	fs.cpSync(
		path.join(project, ".mise/tasks/mdw"),
		path.join(root, ".mise/tasks/mdw"),
		{ recursive: true },
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
		TEST_GH_STATE: stateFile,
	});
	const readState = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));
	const writeState = (data) =>
		fs.writeFileSync(stateFile, JSON.stringify(data));
	writeState({
		prState: "open",
		headSha: "a".repeat(40),
		headRef: "feat/sample",
		pages: [
			{
				hasNextPage: true,
				endCursor: "cursor-1",
				nodes: [
					{
						id: "PRRT_open_1",
						isResolved: false,
						isOutdated: false,
						path: "src/app.mts",
						line: 12,
						originalLine: 12,
						comments: {
							pageInfo: { hasNextPage: false },
							nodes: [
								{
									id: "PRRC_1",
									databaseId: 101,
									body: "ここを修正してください",
									createdAt: "2026-11-25T00:00:00Z",
									url: `${pr}#discussion_r101`,
									author: { login: "reviewer" },
								},
							],
						},
					},
				],
			},
			{
				hasNextPage: false,
				endCursor: "cursor-2",
				nodes: [
					{
						id: "PRRT_resolved_1",
						isResolved: true,
						isOutdated: true,
						path: "src/old.mts",
						line: 3,
						originalLine: 3,
						comments: {
							pageInfo: { hasNextPage: true },
							nodes: [
								{
									id: "PRRC_2",
									databaseId: 102,
									body: "解決済みコメント",
									createdAt: "2026-11-24T00:00:00Z",
									url: `${pr}#discussion_r102`,
									author: { login: "reviewer" },
								},
							],
						},
					},
				],
			},
		],
		replies: [],
		resolvedIds: [],
		failGraphql: false,
		failResolve: false,
	});
	fs.writeFileSync(
		path.join(bin, "gh"),
		[
			"#!/usr/bin/env node",
			"const fs = require('node:fs');",
			"const file = process.env.TEST_GH_STATE;",
			"const state = JSON.parse(fs.readFileSync(file, 'utf8'));",
			"const args = process.argv.slice(2);",
			"if (args[0] !== 'api' || args[1] !== '--hostname' || args[2] !== 'github.com') process.exit(12);",
			"if (args[3] === 'repos/example/project/pulls/34') {",
			`  console.log(JSON.stringify({ html_url: ${JSON.stringify(pr)}, state: state.prState, base: { sha: 'b'.repeat(40) }, head: { sha: state.headSha, ref: state.headRef } }));`,
			"  process.exit(0);",
			"}",
			"if (args[3] !== 'graphql') process.exit(13);",
			"const payload = JSON.parse(fs.readFileSync(0, 'utf8'));",
			"if (state.failGraphql) { console.log(JSON.stringify({ errors: [{ type: 'FORBIDDEN', message: 'boom' }] })); process.exit(1); }",
			"if (payload.query.includes('comments(last: 1)')) {",
			"  const { threadId } = payload.variables;",
			"  const latest = state.truncatedLatest?.[threadId] ?? null;",
			"  console.log(JSON.stringify({ data: { node: { comments: { nodes: latest ? [latest] : [] } } } }));",
			"  process.exit(0);",
			"}",
			"if (payload.query.includes('reviewThreads')) {",
			"  const idx = payload.variables.cursor === 'cursor-1' ? 1 : 0;",
			"  const page = state.pages[idx];",
			"  console.log(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: page.hasNextPage, endCursor: page.endCursor }, nodes: page.nodes } } } } }));",
			"  process.exit(0);",
			"}",
			"if (payload.query.includes('addPullRequestReviewThreadReply')) {",
			"  const { threadId, body } = payload.variables;",
			"  const id = 'PRRC_reply_' + (state.replies.length + 1);",
			`  const url = ${JSON.stringify(`${pr}#discussion_r900`)} + (state.replies.length + 1);`,
			"  state.replies.push({ threadId, body, id, url });",
			"  for (const page of state.pages) for (const node of page.nodes) if (node.id === threadId) node.comments.nodes.push({ id, databaseId: 900 + state.replies.length, body, createdAt: '2026-11-25T01:00:00Z', url, author: { login: 'bot' } });",
			"  fs.writeFileSync(file, JSON.stringify(state));",
			"  console.log(JSON.stringify({ data: { addPullRequestReviewThreadReply: { comment: { id, url } } } }));",
			"  process.exit(0);",
			"}",
			"if (payload.query.includes('resolveReviewThread')) {",
			"  if (state.failResolve) { console.log(JSON.stringify({ errors: [{ type: 'UNPROCESSABLE', message: 'resolve failed' }] })); process.exit(1); }",
			"  const { threadId } = payload.variables;",
			"  state.resolvedIds.push(threadId);",
			"  for (const page of state.pages) for (const node of page.nodes) if (node.id === threadId) node.isResolved = true;",
			"  fs.writeFileSync(file, JSON.stringify(state));",
			"  console.log(JSON.stringify({ data: { resolveReviewThread: { thread: { id: threadId, isResolved: true } } } }));",
			"  process.exit(0);",
			"}",
			"process.exit(14);",
		].join("\n"),
		{ mode: 0o755 },
	);
	const run = (cwd, ...args) =>
		spawnSync(args[0], args.slice(1), { cwd, env, encoding: "utf8" });
	return { root, run, readState, writeState };
}

test("mise から未解決スレッド取得・インライン返信・resolve を実行し、境界値と権限を検証する", (t) => {
	const f = fixture(t);

	const unresolvedRes = f.run(
		f.root,
		"mise",
		"run",
		"mdw:review:threads",
		"--pr",
		pr,
	);
	assert.equal(unresolvedRes.status, 0, unresolvedRes.stderr);
	const unresolved = JSON.parse(unresolvedRes.stdout);
	assert.equal(unresolved.pr, pr);
	assert.equal(unresolved.head_commit, "a".repeat(40));
	assert.equal(unresolved.threads.length, 1);
	assert.equal(unresolved.threads[0].id, "PRRT_open_1");
	assert.equal(unresolved.threads[0].is_resolved, false);
	assert.equal(unresolved.threads[0].comments_truncated, false);

	const allRes = f.run(
		f.root,
		"mise",
		"run",
		"mdw:review:threads",
		"--pr",
		pr,
		"--all",
	);
	assert.equal(allRes.status, 0, allRes.stderr);
	const all = JSON.parse(allRes.stdout);
	assert.equal(all.threads.length, 2);
	assert.equal(all.threads[1].id, "PRRT_resolved_1");
	assert.equal(all.threads[1].comments_truncated, true);

	// --dry-run は外部書き込みを行わない
	const dryRes = f.run(
		f.root,
		"mise",
		"run",
		"mdw:review:reply",
		"--pr",
		pr,
		"--thread",
		"PRRT_open_1",
		"--body",
		"修正しました",
		"--resolve",
		"--dry-run",
	);
	assert.equal(dryRes.status, 0, dryRes.stderr);
	assert.deepEqual(JSON.parse(dryRes.stdout), {
		pr,
		thread_id: "PRRT_open_1",
		body: "修正しました",
		resolve: true,
		already_replied: false,
		already_resolved: false,
		dry_run: true,
	});
	assert.equal(f.readState().replies.length, 0);
	assert.equal(f.readState().resolvedIds.length, 0);

	// 返信のみ（--resolve なし）
	const replyOnly = f.run(
		f.root,
		"mise",
		"run",
		"mdw:review:reply",
		"--pr",
		pr,
		"--thread",
		"PRRT_open_1",
		"--body",
		"確認中です",
	);
	assert.equal(replyOnly.status, 0, replyOnly.stderr);
	const replyOnlyJson = JSON.parse(replyOnly.stdout);
	assert.equal(replyOnlyJson.resolved, false);
	assert.equal(f.readState().replies.length, 1);
	assert.equal(f.readState().resolvedIds.length, 0);

	// サブディレクトリから --body-file と --resolve を指定して返信＋resolve
	const subdir = path.join(f.root, "sub");
	fs.mkdirSync(subdir);
	fs.writeFileSync(path.join(subdir, "reply.md"), "abc1234 で修正しました。\n");
	const resolveRes = f.run(
		subdir,
		"mise",
		"run",
		"mdw:review:reply",
		"--pr",
		pr,
		"--thread",
		"PRRT_open_1",
		"--body-file",
		"reply.md",
		"--resolve",
	);
	assert.equal(resolveRes.status, 0, resolveRes.stderr);
	const resolvedJson = JSON.parse(resolveRes.stdout);
	assert.equal(resolvedJson.resolved, true);
	assert.equal(resolvedJson.already_resolved, false);
	assert.deepEqual(f.readState().resolvedIds, ["PRRT_open_1"]);

	// すでに resolve 済み（かつ comments_truncated: true）スレッドは comments(last: 1) で最新コメントを確認する
	f.writeState({
		...f.readState(),
		truncatedLatest: {
			PRRT_resolved_1: {
				id: "PRRC_latest_105",
				body: "最新の重複本文",
				url: `${pr}#discussion_r105`,
			},
		},
	});
	const truncatedDup = f.run(
		f.root,
		"mise",
		"run",
		"mdw:review:reply",
		"--pr",
		pr,
		"--thread",
		"PRRT_resolved_1",
		"--body",
		"最新の重複本文",
		"--resolve",
	);
	assert.equal(truncatedDup.status, 0, truncatedDup.stderr);
	const truncatedDupJson = JSON.parse(truncatedDup.stdout);
	assert.equal(truncatedDupJson.already_replied, true);
	assert.equal(truncatedDupJson.already_resolved, true);
	assert.equal(f.readState().replies.length, 2);

	const alreadyRes = f.run(
		f.root,
		"mise",
		"run",
		"mdw:review:reply",
		"--pr",
		pr,
		"--thread",
		"PRRT_resolved_1",
		"--body",
		"追記です",
		"--resolve",
	);
	assert.equal(alreadyRes.status, 0, alreadyRes.stderr);
	const alreadyJson = JSON.parse(alreadyRes.stdout);
	assert.equal(alreadyJson.already_replied, false);
	assert.equal(alreadyJson.resolved, true);
	assert.equal(alreadyJson.already_resolved, true);
	assert.deepEqual(f.readState().resolvedIds, ["PRRT_open_1"]);

	// 未解決スレッドが 0 件になったことを確認
	const emptyRes = f.run(
		f.root,
		"mise",
		"run",
		"mdw:review:threads",
		"--pr",
		pr,
	);
	assert.equal(emptyRes.status, 0, emptyRes.stderr);
	assert.deepEqual(JSON.parse(emptyRes.stdout).threads, []);
});

test("異常入力・対象外スレッド・GraphQL 障害・部分失敗を明確に拒否する", (t) => {
	const f = fixture(t);

	// 不正 PR URL
	const badPr = f.run(
		f.root,
		"mise",
		"run",
		"mdw:review:threads",
		"--pr",
		"https://example.invalid/pulls/1",
	);
	assert.equal(badPr.status, 1);
	assert.match(badPr.stderr, /Pull Request の URL/);

	// 対象 PR に属さないスレッド ID
	const foreign = f.run(
		f.root,
		"mise",
		"run",
		"mdw:review:reply",
		"--pr",
		pr,
		"--thread",
		"PRRT_other_pr",
		"--body",
		"hi",
	);
	assert.equal(foreign.status, 1);
	assert.match(foreign.stderr, /見つかりません/);
	assert.equal(f.readState().replies.length, 0);

	// --body と --body-file 同時指定 / 空本文
	const both = f.run(
		f.root,
		"mise",
		"run",
		"mdw:review:reply",
		"--pr",
		pr,
		"--thread",
		"PRRT_open_1",
		"--body",
		"a",
		"--body-file",
		"b.txt",
	);
	assert.equal(both.status, 1);
	assert.match(both.stderr, /同時に指定できません/);

	const blank = f.run(
		f.root,
		"mise",
		"run",
		"mdw:review:reply",
		"--pr",
		pr,
		"--thread",
		"PRRT_open_1",
		"--body",
		"   ",
	);
	assert.equal(blank.status, 1);
	assert.match(blank.stderr, /空でない文字列/);

	// 空文字列の --body "" --resolve や --body "" --body-file も拒否する
	const emptyWithResolve = f.run(
		f.root,
		"mise",
		"run",
		"mdw:review:reply",
		"--pr",
		pr,
		"--thread",
		"PRRT_open_1",
		"--body",
		"",
		"--resolve",
	);
	assert.equal(emptyWithResolve.status, 1);
	assert.match(emptyWithResolve.stderr, /空でない文字列/);
	assert.deepEqual(f.readState().resolvedIds, []);

	const emptyBoth = f.run(
		f.root,
		"mise",
		"run",
		"mdw:review:reply",
		"--pr",
		pr,
		"--thread",
		"PRRT_open_1",
		"--body",
		"",
		"--body-file",
		"reply.md",
	);
	assert.equal(emptyBoth.status, 1);
	assert.match(emptyBoth.stderr, /同時に指定できません/);

	// --body-file は作業ディレクトリ外・シンボリックリンク・サイズ上限超過を拒否する
	const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdw-outside-"));
	t.after(() => fs.rmSync(outsideDir, { recursive: true, force: true }));
	const secretFile = path.join(outsideDir, "secret.txt");
	fs.writeFileSync(secretFile, "top-secret");
	const outsidePath = f.run(
		f.root,
		"mise",
		"run",
		"mdw:review:reply",
		"--pr",
		pr,
		"--thread",
		"PRRT_open_1",
		"--body-file",
		path.relative(f.root, secretFile),
	);
	assert.equal(outsidePath.status, 1);
	assert.match(outsidePath.stderr, /作業ディレクトリ外のファイル/);

	const symlinkFile = path.join(f.root, "link.txt");
	fs.symlinkSync(secretFile, symlinkFile);
	const symlinkRes = f.run(
		f.root,
		"mise",
		"run",
		"mdw:review:reply",
		"--pr",
		pr,
		"--thread",
		"PRRT_open_1",
		"--body-file",
		"link.txt",
	);
	assert.equal(symlinkRes.status, 1);
	assert.match(symlinkRes.stderr, /通常ファイル/);

	fs.writeFileSync(path.join(f.root, "huge.txt"), "x".repeat(70000));
	const hugeRes = f.run(
		f.root,
		"mise",
		"run",
		"mdw:review:reply",
		"--pr",
		pr,
		"--thread",
		"PRRT_open_1",
		"--body-file",
		"huge.txt",
	);
	assert.equal(hugeRes.status, 1);
	assert.match(hugeRes.stderr, /上限/);
	assert.equal(f.readState().replies.length, 0);

	// 返信成功後に resolve のみ失敗した部分失敗
	f.writeState({ ...f.readState(), failResolve: true });
	const partial = f.run(
		f.root,
		"mise",
		"run",
		"mdw:review:reply",
		"--pr",
		pr,
		"--thread",
		"PRRT_open_1",
		"--body",
		"修正しました",
		"--resolve",
	);
	assert.equal(partial.status, 1);
	assert.match(
		partial.stderr,
		/返信.*完了しましたが、resolve に失敗しました.*resolve failed/,
	);
	assert.equal(f.readState().replies.length, 1);

	// 同一本文での再実行は重複返信せず resolve のみ完了できる
	f.writeState({ ...f.readState(), failResolve: false });
	const retriedResolve = f.run(
		f.root,
		"mise",
		"run",
		"mdw:review:reply",
		"--pr",
		pr,
		"--thread",
		"PRRT_open_1",
		"--body",
		"修正しました",
		"--resolve",
	);
	assert.equal(retriedResolve.status, 0, retriedResolve.stderr);
	const retriedJson = JSON.parse(retriedResolve.stdout);
	assert.equal(retriedJson.already_replied, true);
	assert.equal(retriedJson.resolved, true);
	assert.equal(f.readState().replies.length, 1);

	// --resolve 単独指定（本文なし）も許可される
	const resolveOnly = f.run(
		f.root,
		"mise",
		"run",
		"mdw:review:reply",
		"--pr",
		pr,
		"--thread",
		"PRRT_open_1",
		"--resolve",
	);
	assert.equal(resolveOnly.status, 0, resolveOnly.stderr);
	assert.equal(JSON.parse(resolveOnly.stdout).already_resolved, true);

	// GraphQL errors 配列返却
	f.writeState({ ...f.readState(), failGraphql: true });
	const gqlErr = f.run(f.root, "mise", "run", "mdw:review:threads", "--pr", pr);
	assert.equal(gqlErr.status, 1);
	assert.match(gqlErr.stderr, /GraphQL API がエラーを返しました.*boom/);

	// クローズ済み PR
	f.writeState({ ...f.readState(), failGraphql: false, prState: "closed" });
	const closed = f.run(f.root, "mise", "run", "mdw:review:threads", "--pr", pr);
	assert.equal(closed.status, 1);
	assert.match(closed.stderr, /オープンな Pull Request/);
});
