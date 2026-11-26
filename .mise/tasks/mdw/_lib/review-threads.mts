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
              authorAssociation
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

const maxReplyBodyFileBytes = 65536;

const latestThreadCommentQuery = `
query($threadId: ID!) {
  node(id: $threadId) {
    ... on PullRequestReviewThread {
      comments(last: 1) {
        nodes {
          id
          body
          url
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
						author_association:
							typeof comment.authorAssociation === "string"
								? comment.authorAssociation
								: "NONE",
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

function readSafeReplyBodyFile(bodyFile, cwd) {
	if (typeof bodyFile !== "string" || !bodyFile.trim())
		throw new Error("--body-file には空でないファイルパスを指定してください。");
	const base = fs.realpathSync(cwd);
	const resolved = path.resolve(base, bodyFile);
	let lstat: fs.Stats;
	try {
		lstat = fs.lstatSync(resolved);
	} catch {
		throw new Error(`返信本文ファイルを読み取れません: ${bodyFile}`);
	}
	if (lstat.isSymbolicLink() || !lstat.isFile())
		throw new Error(
			"--body-file には作業ディレクトリ配下の通常ファイルを指定してください。",
		);
	const realFile = fs.realpathSync(resolved);
	const relative = path.relative(base, realFile);
	if (
		!relative ||
		relative === ".." ||
		relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative)
	)
		throw new Error(
			"--body-file に作業ディレクトリ外のファイルは指定できません。",
		);
	if (lstat.size > maxReplyBodyFileBytes)
		throw new Error(
			`--body-file のサイズが上限（${maxReplyBodyFileBytes} バイト）を超えています。`,
		);
	return fs.readFileSync(realFile, "utf8");
}

export function resolveReplyBody({
	body,
	bodyFile,
	resolve = false,
	cwd = process.env.MISE_ORIGINAL_CWD || process.cwd(),
} = {}) {
	const hasBody = body !== undefined && body !== null;
	const hasBodyFile = bodyFile !== undefined && bodyFile !== null;
	if (hasBody && hasBodyFile)
		throw new Error("--body と --body-file は同時に指定できません。");
	if (!hasBody && !hasBodyFile) {
		if (resolve) return null;
		throw new Error("--body または --body-file で返信本文を指定してください。");
	}
	const content = hasBodyFile ? readSafeReplyBodyFile(bodyFile, cwd) : body;
	if (typeof content !== "string" || !content.trim())
		throw new Error("返信本文には空でない文字列を指定してください。");
	return content;
}

async function resolveLatestComment(thread) {
	if (!thread.comments_truncated) return thread.comments.at(-1) ?? null;
	const data = await githubGraphql(latestThreadCommentQuery, {
		threadId: thread.id,
	});
	const latest = data?.node?.comments?.nodes?.[0];
	if (!latest || typeof latest.id !== "string")
		throw new Error("対象スレッドの最新コメントを取得できませんでした。");
	return {
		id: latest.id,
		body: latest.body ?? "",
		url: latest.url ?? null,
	};
}

export async function replyToReviewThread(
	target,
	{ threadId, body = null, resolve = false, dryRun = false },
) {
	if (typeof threadId !== "string" || !threadId.trim())
		throw new Error("--thread にレビュースレッド ID を指定してください。");
	if (body === null || body === undefined) {
		if (!resolve)
			throw new Error("返信本文または --resolve を指定してください。");
	} else if (typeof body !== "string" || !body.trim()) {
		throw new Error("返信本文には空でない文字列を指定してください。");
	}

	const { threads } = await fetchReviewThreads(target, {
		includeResolved: true,
	});
	const thread = threads.find((item) => item.id === threadId);
	if (!thread)
		throw new Error(
			"指定したスレッド ID が対象の Pull Request に見つかりません。",
		);

	const lastComment =
		typeof body === "string" ? await resolveLatestComment(thread) : null;
	const duplicateReply = typeof body === "string" && lastComment?.body === body;

	if (dryRun) {
		return {
			pr: target.url,
			thread_id: threadId,
			body,
			resolve: Boolean(resolve),
			already_replied: duplicateReply,
			already_resolved: thread.is_resolved,
			dry_run: true,
		};
	}

	let commentId = null;
	let commentUrl = null;
	let alreadyReplied = false;
	if (typeof body === "string") {
		if (duplicateReply) {
			commentId = lastComment.id;
			commentUrl = lastComment.url;
			alreadyReplied = true;
		} else {
			const replyData = await githubGraphql(replyThreadMutation, {
				threadId,
				body,
			});
			const comment = replyData?.addPullRequestReviewThreadReply?.comment;
			if (typeof comment?.id !== "string" || typeof comment?.url !== "string") {
				throw new Error("スレッドへの返信結果を取得できませんでした。");
			}
			commentId = comment.id;
			commentUrl = comment.url;
		}
	}

	if (!resolve) {
		return {
			pr: target.url,
			thread_id: threadId,
			comment_id: commentId,
			comment_url: commentUrl,
			already_replied: alreadyReplied,
			resolved: thread.is_resolved,
			already_resolved: thread.is_resolved,
		};
	}

	if (thread.is_resolved) {
		return {
			pr: target.url,
			thread_id: threadId,
			comment_id: commentId,
			comment_url: commentUrl,
			already_replied: alreadyReplied,
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
		const suffix = commentUrl
			? `スレッドへの返信（${commentUrl}）は完了しましたが、`
			: "";
		const wrapped = new Error(
			`${suffix}resolve に失敗しました: ${error.message}`,
		) as Error & { replied?: boolean; commentUrl?: string | null };
		if (commentId || alreadyReplied) {
			wrapped.replied = true;
			wrapped.commentUrl = commentUrl;
		}
		throw wrapped;
	}
	if (!resolveData?.resolveReviewThread?.thread?.isResolved) {
		const suffix = commentUrl
			? `スレッドへの返信（${commentUrl}）は完了しましたが、`
			: "";
		const wrapped = new Error(
			`${suffix}resolve 状態を確認できませんでした。`,
		) as Error & { replied?: boolean; commentUrl?: string | null };
		if (commentId || alreadyReplied) {
			wrapped.replied = true;
			wrapped.commentUrl = commentUrl;
		}
		throw wrapped;
	}
	return {
		pr: target.url,
		thread_id: threadId,
		comment_id: commentId,
		comment_url: commentUrl,
		already_replied: alreadyReplied,
		resolved: true,
		already_resolved: false,
	};
}
