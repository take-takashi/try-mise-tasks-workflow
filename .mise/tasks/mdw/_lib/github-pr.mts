import { runCommand } from "./command.mts";

const pullRequestPattern =
	/^https:\/\/github\.com\/([a-z0-9][a-z0-9-]*)\/([a-z0-9_.-]+)\/pull\/([1-9][0-9]*)$/i;

export function parsePullRequestUrl(url) {
	const match = typeof url === "string" && pullRequestPattern.exec(url);
	if (!match || match[2] === "." || match[2] === "..")
		throw new Error(
			"--pr に GitHub の Pull Request の URL を指定してください。",
		);
	const owner = match[1];
	const repo = match[2];
	const number = Number(match[3]);
	return {
		owner,
		repo,
		number,
		url,
		endpoint: `repos/${owner}/${repo}/pulls/${number}`,
	};
}

export async function githubApi(endpoint, args = [], input = "") {
	const { stdout } = await runCommand(
		["gh", "api", "--hostname", "github.com", endpoint, ...args],
		{ input, timeout: 30 },
	);
	try {
		return JSON.parse(stdout.toString("utf8"));
	} catch {
		throw new Error("GitHub API の応答を JSON として読み取れません。");
	}
}

export async function githubGraphql(query, variables = {}) {
	const result = await githubApi(
		"graphql",
		["--method", "POST", "--input", "-"],
		JSON.stringify({ query, variables }),
	);
	if (Array.isArray(result?.errors) && result.errors.length > 0) {
		const summary = result.errors
			.slice(0, 3)
			.map((item) => {
				const kind = typeof item?.type === "string" ? `[${item.type}] ` : "";
				const message =
					typeof item?.message === "string" ? item.message.trim() : "";
				return `${kind}${message}`.slice(0, 160);
			})
			.filter(Boolean)
			.join("; ");
		throw new Error(
			`GitHub GraphQL API がエラーを返しました（${result.errors.length} 件）${summary ? `: ${summary}` : ""}。`,
		);
	}
	if (!result || typeof result.data !== "object" || result.data === null) {
		throw new Error("GitHub GraphQL API の応答データが不正です。");
	}
	return result.data;
}

export async function verifyOpenPullRequest(
	url,
	{ baseCommit, headCommit } = {},
) {
	const parsed = parsePullRequestUrl(url);
	const pr = await githubApi(parsed.endpoint);
	if (pr?.html_url?.toLowerCase() !== url.toLowerCase() || pr.state !== "open")
		throw new Error(
			"指定した URL のオープンな Pull Request を確認できません。",
		);
	if (
		(baseCommit && pr.base?.sha !== baseCommit) ||
		(headCommit && pr.head?.sha !== headCommit)
	)
		throw new Error(
			"Pull Request のベースまたはヘッドが評価時と異なります。レビューを実行し直してください。",
		);
	if (typeof pr.head?.sha !== "string" || !pr.head.sha)
		throw new Error("Pull Request のヘッドコミットを取得できません。");
	return {
		...parsed,
		pr,
		baseSha: pr.base?.sha ?? null,
		headSha: pr.head.sha,
		headRef: pr.head?.ref ?? null,
	};
}

// AI の文章はコードブロックに入れ、メンションや Markdown として解釈されないようにする。
export function asPlainText(value) {
	const longest = Math.max(
		2,
		...Array.from(value.matchAll(/~+/g), ([run]) => run.length),
	);
	const fence = "~".repeat(longest + 1);
	return `${fence}\n${value}\n${fence}`;
}
