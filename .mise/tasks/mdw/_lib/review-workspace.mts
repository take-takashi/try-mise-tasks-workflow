import fs from "node:fs";
import path from "node:path";
import { runCommand } from "./command.mts";
import { readJson, writeJson } from "./json.mts";
import { roles } from "./review-data.mts";

// 一つの worktree の場所を保持し、レビュー用のファイルを読み書きする。
export class ReviewWorkspace {
	readonly root: string;

	constructor(root: string) {
		this.root = path.resolve(root);
	}

	static async discover(cwd = process.env.MISE_ORIGINAL_CWD || process.cwd()) {
		const { stdout } = await runCommand(
			["git", "rev-parse", "--show-toplevel"],
			{ cwd, timeout: 30 },
		);
		return new ReviewWorkspace(stdout.toString("utf8").trim());
	}

	get output() {
		return path.join(this.root, ".reviews");
	}

	read(name: string) {
		return readJson(path.join(this.output, name));
	}

	write(name: string, data) {
		const file = path.join(this.output, name);
		writeJson(file, data);
		return file;
	}

	reset() {
		fs.mkdirSync(this.output, { recursive: true });
		for (const name of [
			"merged.json",
			"judged.json",
			...Object.keys(roles).map((role) => `${role}.json`),
			"manifest.json",
			"diff.txt",
		]) {
			fs.rmSync(path.join(this.output, name), { force: true });
		}
	}
}
