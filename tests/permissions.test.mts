import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("公開タスクだけが実行権限を持つ", {
	skip: process.platform === "win32",
}, () => {
	const root = fileURLToPath(new URL("../.mise/tasks/", import.meta.url));
	function checkLibrary(directory) {
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			const file = path.join(directory, entry.name);
			if (entry.isDirectory()) checkLibrary(file);
			else if (entry.name.endsWith(".mts"))
				assert.equal(fs.statSync(file).mode & 0o111, 0, file);
		}
	}
	for (const name of ["docs", "mdw"])
		checkLibrary(path.join(root, name, "_lib"));
	function checkNonExecutable(directory) {
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			const file = path.join(directory, entry.name);
			if (entry.isDirectory()) checkNonExecutable(file);
			else assert.equal(fs.statSync(file).mode & 0o111, 0, file);
		}
	}
	checkNonExecutable(path.join(root, "mdw/prompts"));
	for (const file of [
		"docs/new.mts",
		"docs/search.mts",
		"docs/validate.mts",
		"mdw/check.mts",
		"mdw/interview.mts",
		"mdw/intent.mts",
		"mdw/issue/new.mts",
		"mdw/worktree/new.mts",
		"mdw/worktree/cleanup.mts",
		"mdw/review.mts",
		"mdw/review/prepare.mts",
		"mdw/review/check.mts",
		"mdw/review/security.mts",
		"mdw/review/architecture.mts",
		"mdw/review/quality.mts",
		"mdw/review/judge.mts",
		"mdw/review/post.mts",
		"mdw/review/threads.mts",
		"mdw/review/reply.mts",
		"mdw/review/fix.mts",
	]) {
		assert.notEqual(fs.statSync(path.join(root, file)).mode & 0o111, 0, file);
	}
});
