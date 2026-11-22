import { runCommand } from "./command.mts";

const pullRequestPattern =
	/^https:\/\/github\.com\/([a-z0-9][a-z0-9-]*)\/([a-z0-9_.-]+)\/pull\/([1-9][0-9]*)$/i;

async function github(endpoint, args = [], input = "") {
	const { stdout } = await runCommand(
		["gh", "api", "--hostname", "github.com", endpoint, ...args],
		{ input, timeout: 30 },
	);
	return JSON.parse(stdout.toString("utf8"));
}

export async function verifyPullRequest(url, target) {
	const match = typeof url === "string" && pullRequestPattern.exec(url);
	if (!match || match[2] === "." || match[2] === "..")
		throw new Error(
			"--pr に GitHub の Pull Request の URL を指定してください。",
		);

	const endpoint = `repos/${match[1]}/${match[2]}/pulls/${match[3]}`;
	const pr = await github(endpoint);
	if (pr?.html_url?.toLowerCase() !== url.toLowerCase() || pr.state !== "open")
		throw new Error(
			"指定した URL のオープンな Pull Request を確認できません。",
		);
	if (
		pr.head?.sha !== target.head_commit ||
		pr.base?.sha !== target.base_commit
	)
		throw new Error(
			"Pull Request のベースまたはヘッドが評価時と異なります。レビューを実行し直してください。",
		);

	return { endpoint: `${endpoint}/reviews`, head: target.head_commit };
}

// AI の文章はコードブロックに入れ、メンションや Markdown として解釈されないようにする。
function asPlainText(value) {
	const longest = Math.max(
		2,
		...Array.from(value.matchAll(/~+/g), ([run]) => run.length),
	);
	const fence = "~".repeat(longest + 1);
	return `${fence}\n${value}\n${fence}`;
}

export function renderReview({
	target,
	candidates,
	decisions,
	reviewLimitations,
	judgeLimitations,
}) {
	const lines = [
		"## MDW レビュー",
		"",
		`対象コミット \`${target.head_commit}\``,
		"",
	];
	const accepted = [];
	for (const [index, decision] of decisions.entries()) {
		if (decision.verdict !== "accepted") continue;
		const { finding } = candidates[index];
		accepted.push(
			asPlainText(
				[
					`[${finding.severity}] ${finding.title}`,
					`${finding.file}:${finding.line}`,
					`判定の根拠: ${decision.reason}`,
				].join("\n"),
			),
		);
	}
	lines.push(
		`採用 ${accepted.length} 件 / 評価 ${decisions.length} 件`,
		"",
		...accepted.flatMap((item) => [item, ""]),
	);
	if (reviewLimitations || judgeLimitations)
		lines.push(
			`確認範囲の制限が報告されています（レビュー ${reviewLimitations} 件、Judge ${judgeLimitations} 件）。`,
		);
	return lines.join("\n").trimEnd();
}

export async function postReview({ endpoint, head }, body) {
	const pages = await github(endpoint, ["--paginate", "--slurp"]);
	const existing = pages
		.flat()
		.find(
			(item) =>
				item.state === "COMMENTED" &&
				item.commit_id === head &&
				item.body === body,
		);
	if (existing) return { url: existing.html_url, alreadyPosted: true };

	const result = await github(
		endpoint,
		["--method", "POST", "--input", "-"],
		JSON.stringify({ commit_id: head, event: "COMMENT", body }),
	);
	if (typeof result?.html_url !== "string")
		throw new Error("GitHub からレビューの URL が返されませんでした。");
	return { url: result.html_url, alreadyPosted: false };
}
