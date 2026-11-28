import { assertSupportedNodeVersion } from "./node-version.mts";

export async function cli(description, action, { usage = false } = {}) {
	try {
		assertSupportedNodeVersion();
		const args = process.argv.slice(2);
		if (args.includes("--help") || args.includes("-h")) {
			console.log(description);
			return;
		}
		if (args.length && !usage)
			throw new Error("不明な引数です: " + args.join(" "));
		if (args.length && usage) {
			const hasUsageEnv = Array.isArray(usage)
				? usage.some((key) => process.env[key] !== undefined)
				: process.env.usage_base !== undefined &&
					process.env.usage_head !== undefined;
			if (!hasUsageEnv)
				throw new Error("引数は mise run から指定してください。");
		}
		await action();
	} catch (error) {
		console.error("エラー: " + error.message);
		process.exitCode = 1;
	}
}
