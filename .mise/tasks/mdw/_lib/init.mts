import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { findExecutableOnPath, supportedProviders } from "./agent-client.mts";
import { discoverRoot } from "./interactive.mts";
import { checkNodeVersion } from "./node-version.mts";

export const confDTemplate = [
	"# Managed by MDW",
	"[env]",
	"_.file = [",
	'  ".mdw/models.env",',
	'  { path = ".mdw/models.local.env", redact = true },',
	"]",
	"",
].join("\n");

export const mdwGitignoreTemplate = [
	"# Managed by MDW",
	"models.local.env",
	"",
].join("\n");

export const modelsEnvTemplate = [
	"# MDW 共通の設定既定値です。API キーなどの秘密情報は記載しないでください。",
	"# MDW_DEFAULT_MODEL を未指定にすると、各 AI CLI 側の既定モデルを使います。",
	"MDW_DEFAULT_PROVIDER=codex",
	"# MDW_DEFAULT_MODEL=",
	"MDW_DEFAULT_EFFORT=medium",
	"MDW_DEFAULT_BILLING=subscription",
	"",
].join("\n");

const initEntries = [
	{
		relativePath: ".mise/conf.d/mdw.toml",
		content: confDTemplate,
		managed: true,
	},
	{
		relativePath: ".mdw/.gitignore",
		content: mdwGitignoreTemplate,
		managed: true,
	},
	{
		relativePath: ".mdw/models.env",
		content: modelsEnvTemplate,
		managed: false,
	},
];

export async function resolveGitRoot(
	cwd = process.env.MISE_ORIGINAL_CWD || process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
) {
	if (!findExecutableOnPath("git", env, cwd, platform)) {
		throw new Error(
			"git CLI が PATH に見つかりません。Git をインストールしてから再実行してください。",
		);
	}
	try {
		return await discoverRoot(cwd, { env });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes("タイムアウト")) {
			throw new Error(`Git ルートの確認がタイムアウトしました: ${message}`);
		}
		throw new Error(
			"Git リポジトリ内で実行してください（Git 管理外のディレクトリには初期化できません）。",
		);
	}
}

function assertSafeAncestors(root: string, relativePath: string) {
	const segments = relativePath.split("/").slice(0, -1);
	let current = path.resolve(root);
	for (const segment of segments) {
		current = path.join(current, segment);
		let stats: fs.Stats;
		try {
			stats = fs.lstatSync(current);
		} catch (error) {
			if (error?.code === "ENOENT") continue;
			throw error;
		}
		if (stats.isSymbolicLink()) {
			throw new Error(
				`${path.relative(root, current)} にシンボリックリンクは使用できません。`,
			);
		}
		if (!stats.isDirectory()) {
			throw new Error(
				`${path.relative(root, current)} はディレクトリではありません。`,
			);
		}
	}
}

function inspectTargetFile(fullPath: string, relativePath: string) {
	let stats: fs.Stats;
	try {
		stats = fs.lstatSync(fullPath);
	} catch (error) {
		if (error?.code === "ENOENT") return { exists: false, content: null };
		throw error;
	}
	if (stats.isSymbolicLink()) {
		throw new Error(`${relativePath} にシンボリックリンクは使用できません。`);
	}
	if (!stats.isFile()) {
		throw new Error(`${relativePath} は通常ファイルではありません。`);
	}
	return { exists: true, content: fs.readFileSync(fullPath, "utf8") };
}

function writeAtomic(fullPath: string, content: string, overwrite: boolean) {
	const dir = path.dirname(fullPath);
	fs.mkdirSync(dir, { recursive: true });
	if (!overwrite) {
		fs.writeFileSync(fullPath, content, { encoding: "utf8", flag: "wx" });
		return;
	}
	const temporary = path.join(dir, `.tmp-${randomUUID()}`);
	try {
		fs.writeFileSync(temporary, content, { encoding: "utf8", flag: "wx" });
		fs.renameSync(temporary, fullPath);
	} finally {
		fs.rmSync(temporary, { force: true });
	}
}

export function planAndApplyInitFiles(
	root: string,
	{ force = false, dryRun = false } = {},
) {
	const resolvedRoot = path.resolve(root);
	const planned = initEntries.map((entry) => {
		assertSafeAncestors(resolvedRoot, entry.relativePath);
		const fullPath = path.join(resolvedRoot, entry.relativePath);
		const existing = inspectTargetFile(fullPath, entry.relativePath);

		if (!existing.exists) {
			return {
				entry,
				fullPath,
				action: dryRun ? "would_create" : "created",
				differs: false,
				needsWrite: !dryRun,
				overwrite: false,
			};
		}

		const differs = existing.content !== entry.content;
		if (force && entry.managed) {
			if (!differs) {
				return {
					entry,
					fullPath,
					action: "unchanged",
					differs: false,
					needsWrite: false,
					overwrite: false,
				};
			}
			return {
				entry,
				fullPath,
				action: dryRun ? "would_update" : "updated",
				differs: true,
				needsWrite: !dryRun,
				overwrite: true,
			};
		}

		return {
			entry,
			fullPath,
			action: "skipped",
			differs,
			needsWrite: false,
			overwrite: false,
		};
	});

	for (const item of planned) {
		if (!item.needsWrite) continue;
		assertSafeAncestors(resolvedRoot, item.entry.relativePath);
		writeAtomic(item.fullPath, item.entry.content, item.overwrite);
	}

	return planned.map((item) => ({
		path: item.entry.relativePath,
		managed: item.entry.managed,
		action: item.action,
		differs: item.differs,
	}));
}

function collectPublicTaskFiles(directory: string, list: string[] = []) {
	if (!fs.existsSync(directory)) return list;
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		const fullPath = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "_lib" || entry.name === "prompts") continue;
			collectPublicTaskFiles(fullPath, list);
		} else if (entry.isFile() && entry.name.endsWith(".mts")) {
			list.push(fullPath);
		}
	}
	return list;
}

function inspectMiseTomlOverlap(root: string) {
	const overlapping: string[] = [];
	for (const name of ["mise.toml", ".mise.toml"]) {
		const filePath = path.join(root, name);
		try {
			const stats = fs.lstatSync(filePath);
			if (!stats.isFile()) continue;
			const content = fs.readFileSync(filePath, "utf8");
			if (content.includes(".mdw/models.env")) {
				overlapping.push(name);
			}
		} catch {}
	}
	return overlapping;
}

function shellQuotePosix(value: string) {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

export function diagnoseEnvironment(
	root: string,
	{
		env = process.env,
		nodeVersion = process.versions.node,
		platform = process.platform,
	} = {},
) {
	const resolvedRoot = path.resolve(root);
	const node = checkNodeVersion(nodeVersion);
	const git = findExecutableOnPath("git", env, resolvedRoot, platform);
	const gh = findExecutableOnPath("gh", env, resolvedRoot, platform);
	const aiClis = Object.fromEntries(
		supportedProviders.map((provider) => [
			provider,
			findExecutableOnPath(provider, env, resolvedRoot, platform),
		]),
	);
	const detectedAiClis = Object.entries(aiClis)
		.filter(([, found]) => Boolean(found))
		.map(([name]) => name);

	const tasksDir = path.join(resolvedRoot, ".mise/tasks/mdw");
	const nonExecutableTasks: string[] = [];
	if (platform !== "win32") {
		for (const filePath of collectPublicTaskFiles(tasksDir)) {
			try {
				const stats = fs.lstatSync(filePath);
				if (stats.isFile() && (stats.mode & 0o111) === 0) {
					nonExecutableTasks.push(
						path.relative(resolvedRoot, filePath).split(path.sep).join("/"),
					);
				}
			} catch {}
		}
	}

	const miseTomlOverlap = inspectMiseTomlOverlap(resolvedRoot);

	const warnings: string[] = [];
	if (!node.ok && node.reason) warnings.push(node.reason);
	if (!git) warnings.push("git CLI が PATH に見つかりません。");
	if (!gh)
		warnings.push(
			"gh CLI が PATH に見つかりません（PR / Issue 操作タスクを使う場合に必要です）。",
		);
	if (detectedAiClis.length === 0) {
		warnings.push(
			`AI CLI（${supportedProviders.join(" / ")}）が PATH に見つかりません（mdw:intent や --prompt 以外の実行にはいずれかの CLI が必要です）。`,
		);
	}
	if (nonExecutableTasks.length > 0) {
		warnings.push(
			`実行権限が不足している公開タスクがあります: ${nonExecutableTasks.join(", ")}`,
		);
	}
	if (miseTomlOverlap.length > 0) {
		warnings.push(
			`${miseTomlOverlap.join(", ")} に .mdw/models.env の設定が残っています。.mise/conf.d/mdw.toml と重複するため不要であれば整理してください。`,
		);
	}

	return {
		node,
		git: { found: Boolean(git), path: git },
		gh: { found: Boolean(gh), path: gh },
		ai_clis: {
			detected: detectedAiClis,
			paths: aiClis,
		},
		task_permissions: {
			checked: platform !== "win32",
			missing_executable: nonExecutableTasks,
		},
		mise_toml_overlap: miseTomlOverlap,
		warnings,
	};
}

export function buildNextSteps(files, diagnostics) {
	const steps: string[] = [];
	if (
		files.some(
			(item) => item.managed && item.action === "skipped" && item.differs,
		)
	) {
		steps.push(
			"MDW 管理ファイルに差分があります。最新内容へ更新する場合は `mise run mdw:init --force` を実行してください（.mdw/models.env は上書きされません）。",
		);
	}
	if (diagnostics.task_permissions.missing_executable.length > 0) {
		const quotedPaths = diagnostics.task_permissions.missing_executable
			.map(shellQuotePosix)
			.join(" ");
		steps.push(
			`公開タスクに実行権限を付与してください: chmod +x -- ${quotedPaths}`,
		);
	}
	if (
		files.some(
			(item) =>
				item.path === ".mise/conf.d/mdw.toml" &&
				(item.action === "created" || item.action === "updated"),
		)
	) {
		steps.push(
			"`.mise/conf.d/mdw.toml` を初回読み込みする際に確認が出た場合は `mise trust` を実行してください。",
		);
	}
	steps.push(
		".mdw/models.env の既定プロバイダーやモデル設定を確認し、個人用の上書きは .mdw/models.local.env に記載してください。",
	);
	steps.push(
		"レビュー等で AI CLI を使う前に `mise run mdw:check` で設定と認証状態を確認してください。",
	);
	return steps;
}
