import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";

export function readJson(file) {
	try {
		return JSON.parse(
			new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
				fs.readFileSync(file),
			),
		);
	} catch (error) {
		throw new Error(path.basename(file) + " を読み取れません: " + error.name);
	}
}

export function writeJson(file, data) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temporary = path.join(path.dirname(file), ".tmp-" + randomUUID());
	try {
		fs.writeFileSync(temporary, JSON.stringify(data, null, 2) + "\n", {
			encoding: "utf8",
			flag: "wx",
			mode: 0o600,
		});
		fs.renameSync(temporary, file);
	} finally {
		fs.rmSync(temporary, { force: true });
	}
}
