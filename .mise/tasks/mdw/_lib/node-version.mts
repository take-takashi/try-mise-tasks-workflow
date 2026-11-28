import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SUPPORTED_NODE_REQUIREMENT =
	"Node.js v22.18.0 以降（22 系 LTS）または v24.2.0 以降";

const nodeVersionPattern =
	/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseNodeVersion(raw: unknown) {
	if (typeof raw !== "string") return null;
	const trimmed = raw.trim();
	const match = nodeVersionPattern.exec(trimmed);
	if (!match) return null;
	const major = Number(match[1]);
	const minor = Number(match[2]);
	const patch = Number(match[3]);
	if (
		!Number.isSafeInteger(major) ||
		!Number.isSafeInteger(minor) ||
		!Number.isSafeInteger(patch)
	) {
		return null;
	}
	return {
		major,
		minor,
		patch,
		prerelease: match[4] ?? null,
		normalized: `${major}.${minor}.${patch}${match[4] ? `-${match[4]}` : ""}`,
	};
}

export function checkNodeVersion(...args: unknown[]) {
	const raw = args.length === 0 ? process.versions.node : args[0];
	const parsed = parseNodeVersion(raw);
	if (!parsed) {
		return {
			ok: false,
			version: null,
			requirement: SUPPORTED_NODE_REQUIREMENT,
			reason: `Node.js のバージョンを判別できません（${String(raw ?? "")}）。${SUPPORTED_NODE_REQUIREMENT} を利用してください。`,
		};
	}

	const { major, minor, patch, prerelease, normalized } = parsed;
	let supported = false;
	if (major === 22) {
		supported =
			minor > 18 || (minor === 18 && (patch > 0 || prerelease === null));
	} else if (major === 24) {
		supported =
			minor > 2 || (minor === 2 && (patch > 0 || prerelease === null));
	} else if (major >= 25) {
		supported = true;
	}

	if (supported) {
		return {
			ok: true,
			version: normalized,
			requirement: SUPPORTED_NODE_REQUIREMENT,
			reason: null,
		};
	}

	const detail =
		major === 24 && minor < 2
			? "Node.js v24.0〜v24.1 は import.meta.main に未対応のため使用できません。"
			: major === 23
				? "Node.js 23 系は .mts の無設定実行と import.meta.main の要件を満たさないため使用できません。"
				: ".mts の無設定実行と import.meta.main に対応していません。";

	return {
		ok: false,
		version: normalized,
		requirement: SUPPORTED_NODE_REQUIREMENT,
		reason: `現在の Node.js (v${normalized}) は非対応です。${detail}${SUPPORTED_NODE_REQUIREMENT} を利用してください。`,
	};
}

export function assertSupportedNodeVersion(...args: unknown[]) {
	const result =
		args.length === 0 ? checkNodeVersion() : checkNodeVersion(args[0]);
	if (!result.ok) {
		throw new Error(result.reason ?? SUPPORTED_NODE_REQUIREMENT);
	}
	return result;
}

function resolveRealOrAbsolute(filePath: string) {
	try {
		return fs.realpathSync(filePath);
	} catch {
		return path.resolve(filePath);
	}
}

// import.meta.main が未定義のバージョンでも直接実行を判別できるようにする補助関数。
export function isMainModule(
	meta: { main?: unknown; url?: string } | undefined,
	argv: string[] = process.argv,
) {
	if (typeof meta?.main === "boolean") return meta.main;
	if (typeof meta?.url !== "string" || !meta.url.startsWith("file:")) {
		return false;
	}
	const entry = argv[1];
	if (typeof entry !== "string" || !entry) return false;
	return (
		resolveRealOrAbsolute(fileURLToPath(meta.url)) ===
		resolveRealOrAbsolute(entry)
	);
}
