import fs from "node:fs";
import path from "node:path";
import { githubGraphql } from "./github-pr.mts";

const reviewThreadsQuery = `
query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          originalLine
          comments(first: 100) {
            pageInfo {
              hasNextPage
            }
            nodes {
              id
              databaseId
              body
              createdAt
              url
              author {
                login
              }
            }
          }
        }
      }
    }
  }
}
`;

const replyThreadMutation = `
mutation($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: {
    pullRequestReviewThreadId: $threadId,
    body: $body
  }) {
    comment {
      id
      url
    }
  }
}
`;

const resolveThreadMutation = `
mutation($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) {
    thread {
      id
      isResolved
    }
  }
}
`;

export async function fetchReviewThreads(
	target,
	{ includeResolved = false, maxPages = 50 } = {},
) {
	const threads = [];
	let cursor = null;
	for (let page = 0; page < maxPages; page++) {
		const data = await githubGraphql(reviewThreadsQuery, {
			owner: target.owner,
			repo: target.repo,
			number: target.number,
			cursor,
		});
		const connection = data?.repository?.pullRequest?.reviewThreads;
		if (!connection || !Array.isArray(connection.nodes)) {
			throw new Error("Pull Request のレビュースレッド一覧を取得できません。");
		}
		for (const node of connection.nodes) {
			if (!node || typeof node.id !== "string") continue;
			const thread = {
				id: node.id,
				is_resolved: Boolean(node.isResolved),
				is_outdated: Boolean(node.isOutdated),
				path: node.path ?? null,
				line: node.line ?? null,
				original_line: node.originalLine ?? null,
				comments_truncated: Boolean(node.comments?.pageInfo?.hasNextPage),
				comments: (node.comments?.nodes ?? [])
					.filter((comment) => comment && typeof comment.id === "string")
					.map((comment) => ({
						id: comment.id,
						database_id: comment.databaseId ?? null,
						author: comment.author?.login ?? null,
						body: comment.body ?? "",
						created_at: comment.createdAt ?? null,
						url: comment.url ?? null,
					})),
			};
			if (includeResolved || !thread.is_resolved) threads.push(thread);
		}
		if (!connection.pageInfo?.hasNextPage) {
			return {
				pr: target.url,
				head_commit: target.headSha,
				head_ref: target.headRef,
				threads,
			};
		}
		const nextCursor = connection.pageInfo?.endCursor;
		if (typeof nextCursor !== "string" || !nextCursor || nextCursor === cursor)
			throw new Error("レビュースレッドのページネーション情報が不正です。");
		cursor = nextCursor;
	}
	throw new Error(
		`レビュースレッドの取得が上限ページ数（${maxPages}）を超えました。`,
	);
}

export function resolveReplyBody({
	body,
	bodyFile,
	cwd = process.env.MISE_ORIGINAL_CWD || process.cwd(),
} = {}) {
	const hasBody = typeof body === "string" && body.length > 0;
	const hasBodyFile = typeof bodyFile === "string" && bodyFile.length > 0;
	if (hasBody && hasBodyFile)
		throw new Error("--body と --body-file は同時に指定できません。");
	if (!hasBody && !hasBodyFile)
		throw new Error("--body または --body-file で返信本文を指定してください。");
	let content = body;
	if (hasBodyFile) {
		const resolved = path.resolve(cwd, bodyFile);
		try {
			content = fs.readFileSync(resolved, "utf8");
		} catch {
			throw new Error(`返信本文ファイルを読み取れません: ${bodyFile}`);
		}
	}
	if (!content.trim())
		throw new Error("返信本文には空でない文字列を指定してください。");
	return content;
}

export async function replyToReviewThread(
	target,
	{ threadId, body, resolve = false, dryRun = false },
) {
	if (typeof threadId !== "string" || !threadId.trim())
		throw new Error("--thread にレビュースレッド ID を指定してください。");
	if (typeof body !== "string" || !body.trim())
		throw new Error("返信本文には空でない文字列を指定してください。");

	const { threads } = await fetchReviewThreads(target, {
		includeResolved: true,
	});
	const thread = threads.find((item) => item.id === threadId);
	if (!thread)
		throw new Error(
			"指定したスレッド ID が対象の Pull Request に見つかりません。",
		);

	if (dryRun) {
		return {
			pr: target.url,
			thread_id: threadId,
			body,
			resolve: Boolean(resolve),
			already_resolved: thread.is_resolved,
			dry_run: true,
		};
	}

	const replyData = await githubGraphql(replyThreadMutation, {
		threadId,
		body,
	});
	const comment = replyData?.addPullRequestReviewThreadReply?.comment;
	if (typeof comment?.id !== "string" || typeof comment?.url !== "string") {
		throw new Error("スレッドへの返信結果を取得できませんでした。");
	}

	if (!resolve) {
		return {
			pr: target.url,
			thread_id: threadId,
			comment_id: comment.id,
			comment_url: comment.url,
			resolved: thread.is_resolved,
			already_resolved: thread.is_resolved,
		};
	}

	if (thread.is_resolved) {
		return {
			pr: target.url,
			thread_id: threadId,
			comment_id: comment.id,
			comment_url: comment.url,
			resolved: true,
			already_resolved: true,
		};
	}

	let resolveData: {
		resolveReviewThread?: { thread?: { isResolved?: boolean } };
	};
	try {
		resolveData = await githubGraphql(resolveThreadMutation, { threadId });
	} catch (error) {
		throw new Error(
			`スレッドへの返信（${comment.url}）は完了しましたが、resolve に失敗しました: ${error.message}`,
		);
	}
	if (!resolveData?.resolveReviewThread?.thread?.isResolved) {
		throw new Error(
			`スレッドへの返信（${comment.url}）は完了しましたが、resolve 状態を確認できませんでした。`,
		);
	}
	return {
		pr: target.url,
		thread_id: threadId,
		comment_id: comment.id,
		comment_url: comment.url,
		resolved: true,
		already_resolved: false,
	};
}
