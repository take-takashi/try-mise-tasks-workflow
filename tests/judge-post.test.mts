import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseDiffLineRanges } from "../.mise/tasks/mdw/_lib/post-review.mts";

const project = fileURLToPath(new URL("..", import.meta.url));
const pr = "https://github.com/example/project/pull/12";

function fixture(t) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "mdw-judge-post-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const bin = path.join(root, "bin");
	const output = path.join(root, ".reviews");
	const state = path.join(root, "github.json");
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
		MDW_REVIEW_JUDGE_PROVIDER: "codex",
		TEST_GITHUB_STATE: state,
	});
	const run = (...args) =>
		spawnSync(args[0], args.slice(1), { cwd: root, env, encoding: "utf8" });
	const ok = (...args) => {
		const result = run(...args);
		assert.equal(result.status, 0, result.stderr || String(result.error));
		return result.stdout.trim();
	};
	const task = (name, ...args) => [
		"mise",
		"run",
		`mdw:review:${name}`,
		...args,
	];
	ok("git", "init", "-b", "main");
	ok("git", "config", "commit.gpgsign", "false");
	ok("git", "config", "user.name", "Test User");
	ok("git", "config", "user.email", "test@example.invalid");
	fs.writeFileSync(
		path.join(root, "example.txt"),
		`${Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n")}\n`,
	);
	ok("git", "add", "example.txt");
	ok("git", "commit", "-m", "base");
	const base = ok("git", "rev-parse", "HEAD");
	ok("git", "switch", "-c", "feat/example");
	fs.writeFileSync(
		path.join(root, "example.txt"),
		`${[
			"changed line 1",
			...Array.from({ length: 19 }, (_, i) => `line ${i + 2}`),
		].join("\n")}\n`,
	);
	ok("git", "commit", "-am", "change");
	const head = ok("git", "rev-parse", "HEAD");

	ok(...task("prepare", "--base", base, "--head", head));
	const target = JSON.parse(
		fs.readFileSync(path.join(output, "manifest.json"), "utf8"),
	);
	const summary = {
		target,
		reviews: ["security", "architecture", "quality"].map((reviewer_id) => ({
			target,
			reviewer_id,
			review: { findings: [], limitations: [], file_coverage: [] },
		})),
	};
	const writeSummary = () =>
		fs.writeFileSync(path.join(output, "merged.json"), JSON.stringify(summary));
	const readState = () => JSON.parse(fs.readFileSync(state, "utf8"));
	const writeState = (data) => fs.writeFileSync(state, JSON.stringify(data));
	writeState({ base, head, reviews: [] });
	fs.writeFileSync(
		path.join(bin, "gh"),
		[
			"#!/usr/bin/env node",
			"const fs = require('node:fs');",
			"const file = process.env.TEST_GITHUB_STATE;",
			"const state = JSON.parse(fs.readFileSync(file, 'utf8'));",
			"const args = process.argv.slice(2);",
			"if (args[0] !== 'api' || args[1] !== '--hostname' || args[2] !== 'github.com') process.exit(12);",
			"if (args[3] === 'repos/example/project/pulls/12') {",
			`  console.log(JSON.stringify({ html_url: ${JSON.stringify(pr)}, state: 'open', base: { sha: state.base }, head: { sha: state.head, ref: 'feat/example' } }));`,
			"} else if (args[3] === 'repos/example/project/pulls/12/reviews') {",
			"  if (args.includes('POST')) {",
			"    const input = JSON.parse(fs.readFileSync(0, 'utf8'));",
			"    if (input.event !== 'COMMENT' || input.commit_id !== state.head) process.exit(13);",
			"    const id = state.reviews.length + 1;",
			`    const review = { id, ...input, state: 'COMMENTED', html_url: ${JSON.stringify(`${pr}#pullrequestreview-`)} + id };`,
			"    state.reviews.push(review); fs.writeFileSync(file, JSON.stringify(state)); console.log(JSON.stringify(review));",
			"  } else if (args.includes('--paginate') && args.includes('--slurp')) console.log(JSON.stringify([state.reviews]));",
			"  else process.exit(14);",
			"} else if (/^repos\\/example\\/project\\/pulls\\/12\\/reviews\\/\\d+\\/comments$/.test(args[3])) {",
			"  const id = Number(args[3].split('/')[6]);",
			"  const review = state.reviews.find((item) => item.id === id);",
			"  console.log(JSON.stringify([review?.comments ?? []]));",
			"} else process.exit(15);",
		].join("\n"),
		{ mode: 0o755 },
	);
	return {
		bin,
		run,
		ok,
		task,
		output,
		summary,
		writeSummary,
		readState,
		writeState,
	};
}

test("unified diff のハンク行範囲を本文中の擬似ヘッダと混同せずに抽出する", () => {
	const diff = [
		"diff --git a/deleted.txt b/deleted.txt",
		"deleted file mode 100644",
		"--- a/deleted.txt",
		"+++ /dev/null",
		"@@ -1,2 +0,0 @@",
		"-old 1",
		"-old 2",
		"diff --git a/src/app.mts b/src/app.mts",
		"--- a/src/app.mts",
		"+++ b/src/app.mts",
		"@@ -1,2 +1,4 @@",
		" line 1",
		"+++ b/fake.mts",
		"+@@ -99,1 +99,1 @@",
		" line 2",
		"diff --git a/other.mts b/other.mts",
		"--- a/other.mts",
		"+++ b/other.mts",
		"@@ -10 +10 @@",
		"-old",
		"+new",
		"",
	].join("\n");
	const ranges = parseDiffLineRanges(diff);
	assert.equal(ranges.has("deleted.txt"), false);
	assert.equal(ranges.has("fake.mts"), false);
	assert.deepEqual(ranges.get("src/app.mts"), [{ start: 1, end: 4 }]);
	assert.deepEqual(ranges.get("other.mts"), [{ start: 10, end: 10 }]);
});

test("mise から指摘を評価し、採用分をインラインコメントと本文フォールバックで PR に投稿する", (t) => {
	const f = fixture(t);
	const inlineFinding = {
		severity: "medium",
		file: "example.txt",
		line: 1,
		title: "採用するインライン指摘 @example",
		evidence: "ローカルの根拠",
		recommendation: "1行目を修正",
	};
	const outsideFinding = {
		severity: "low",
		file: "example.txt",
		line: 18,
		title: "diff 範囲外の採用指摘",
		evidence: "18行目の根拠",
		recommendation: "18行目を修正",
	};
	f.summary.reviews[0].review.findings.push(inlineFinding);
	f.summary.reviews[1].review.findings.push(outsideFinding);
	f.summary.reviews[2].review.findings.push({
		...inlineFinding,
		title: "重複した指摘",
	});
	f.writeSummary();

	const decisions = [
		{
			id: "quality:1",
			verdict: "duplicate",
			reason: "同じ原因",
			duplicate_of: "security:1",
		},
		{
			id: "architecture:1",
			verdict: "accepted",
			reason: "範囲外だが影響あり",
			duplicate_of: null,
		},
		{
			id: "security:1",
			verdict: "accepted",
			reason: "差分で確認した\n~~~\n@another",
			duplicate_of: null,
		},
	];
	fs.writeFileSync(
		path.join(f.bin, "codex"),
		[
			"#!/usr/bin/env node",
			"const fs = require('node:fs');",
			"const args = process.argv.slice(2);",
			"if (args[0] === 'login') { console.log('Logged in using ChatGPT'); process.exit(0); }",
			"if (args.includes('--model')) process.exit(12);",
			"const prompt = fs.readFileSync(0, 'utf8');",
			`if (!prompt.includes(${JSON.stringify(f.summary.target.head_commit)}) || !prompt.includes('quality:1')) process.exit(11);`,
			`fs.writeFileSync(args[args.indexOf('-o') + 1], JSON.stringify({ decisions: ${JSON.stringify(decisions)} }));`,
		].join("\n"),
		{ mode: 0o755 },
	);

	f.ok(...f.task("judge"));
	const saved = JSON.parse(
		fs.readFileSync(path.join(f.output, "judged.json"), "utf8"),
	);
	assert.deepEqual(saved.judge, { provider: "codex", model: null });
	assert.deepEqual(saved.decisions, [decisions[2], decisions[1], decisions[0]]);
	const preview = f.ok(...f.task("post", "--dry-run"));
	assert.match(
		preview,
		/採用 2 件 \/ 評価 3 件（インライン 1 件、本文記載 1 件）/,
	);
	assert.match(preview, /### インラインコメント予定/);
	assert.match(preview, /`example\.txt:1` \(RIGHT\)/);
	assert.match(preview, /~~~~\n\[medium\] 採用するインライン指摘 @example/);
	assert.match(preview, /\[low\] diff 範囲外の採用指摘/);
	assert.doesNotMatch(preview, /重複した指摘|ローカルの根拠/);
	assert.equal(f.readState().reviews.length, 0);

	const original = f.readState();
	f.writeState({ ...original, head: "0".repeat(40) });
	const changed = f.run(...f.task("post", "--pr", pr));
	assert.equal(changed.status, 1);
	assert.match(changed.stderr, /ヘッドが評価時と異なります/);
	assert.equal(f.readState().reviews.length, 0);
	f.writeState(original);
	const posted = JSON.parse(f.ok(...f.task("post", "--pr", pr)));
	assert.deepEqual(posted, {
		url: `${pr}#pullrequestreview-1`,
		alreadyPosted: false,
		inlineCount: 1,
		fallbackCount: 1,
	});
	const postedReview = f.readState().reviews[0];
	assert.equal(postedReview.comments.length, 1);
	assert.equal(postedReview.comments[0].path, "example.txt");
	assert.equal(postedReview.comments[0].line, 1);
	assert.equal(postedReview.comments[0].side, "RIGHT");
	assert.match(postedReview.comments[0].body, /~~~~\n\[medium\]/);
	assert.match(postedReview.body, /diff 範囲外の採用指摘/);

	const retried = JSON.parse(f.ok(...f.task("post", "--pr", pr)));
	assert.equal(retried.alreadyPosted, true);
	assert.equal(f.readState().reviews.length, 1);

	f.summary.reviews[0].review.limitations.push("新しい制限");
	f.writeSummary();
	const stale = f.run(...f.task("post", "--pr", pr));
	assert.equal(stale.status, 1);
	assert.match(stale.stderr, /評価結果が現在のレビューと一致しません/);
});

test("指摘がない場合は AI CLI を呼ばず、空の評価結果を作る", (t) => {
	const f = fixture(t);
	f.writeSummary();
	fs.writeFileSync(path.join(f.bin, "codex"), "#!/bin/sh\nexit 15\n", {
		mode: 0o755,
	});
	f.ok(...f.task("judge"));
	const saved = JSON.parse(
		fs.readFileSync(path.join(f.output, "judged.json"), "utf8"),
	);
	assert.equal(saved.judge, null);
	assert.deepEqual(saved.decisions, []);
	assert.match(f.ok(...f.task("post", "--dry-run")), /採用 0 件 \/ 評価 0 件/);
});
