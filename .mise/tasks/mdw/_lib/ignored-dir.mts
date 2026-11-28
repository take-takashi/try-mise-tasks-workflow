import fs from "node:fs";
import path from "node:path";

const selfIgnoringGitignore = "# Created by MDW\n*\n";

function assertNotSymlinkOrInvalid(
	target: string,
	label: string,
	kind: "dir" | "file",
) {
	let stats: fs.Stats;
	try {
		stats = fs.lstatSync(target);
	} catch (error) {
		if (error?.code === "ENOENT") return false;
		throw error;
	}
	if (stats.isSymbolicLink()) {
		throw new Error(`${label} にシンボリックリンクは使用できません。`);
	}
	if (kind === "dir" && !stats.isDirectory()) {
		throw new Error(`${label} はディレクトリではありません。`);
	}
	if (kind === "file" && !stats.isFile()) {
		throw new Error(`${label} は通常ファイルではありません。`);
	}
	return true;
}

// 対象ディレクトリを安全に作成し、未存在であれば自身を含めて無視する .gitignore を配置する。
export function ensureIgnoredDirectory(
	dir: string,
	label = path.basename(dir),
) {
	const dirExists = assertNotSymlinkOrInvalid(dir, label, "dir");
	if (!dirExists) {
		fs.mkdirSync(dir, { recursive: true });
		assertNotSymlinkOrInvalid(dir, label, "dir");
	}
	const gitignore = path.join(dir, ".gitignore");
	const gitignoreLabel = `${label}/.gitignore`;
	if (assertNotSymlinkOrInvalid(gitignore, gitignoreLabel, "file")) {
		return;
	}
	try {
		fs.writeFileSync(gitignore, selfIgnoringGitignore, {
			encoding: "utf8",
			flag: "wx",
		});
	} catch (error) {
		if (error?.code === "EEXIST") {
			assertNotSymlinkOrInvalid(gitignore, gitignoreLabel, "file");
			return;
		}
		throw error;
	}
}
