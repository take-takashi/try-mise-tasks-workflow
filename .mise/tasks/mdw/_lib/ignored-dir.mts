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
export function ensureIgnoredDirectory(dir: string, label?: string) {
	const targetDir = path.resolve(dir);
	const displayLabel = label ?? path.basename(targetDir);
	const dirExists = assertNotSymlinkOrInvalid(targetDir, displayLabel, "dir");
	if (!dirExists) {
		fs.mkdirSync(targetDir, { recursive: true });
		assertNotSymlinkOrInvalid(targetDir, displayLabel, "dir");
	}
	const gitignore = path.join(targetDir, ".gitignore");
	const gitignoreLabel = `${displayLabel}/.gitignore`;
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
