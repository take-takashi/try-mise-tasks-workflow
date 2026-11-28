import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
	assertSupportedNodeVersion,
	checkNodeVersion,
	isMainModule,
	parseNodeVersion,
	SUPPORTED_NODE_REQUIREMENT,
} from "../.mise/tasks/mdw/_lib/node-version.mts";

test("対応する Node.js バージョンを正しく判定する", () => {
	for (const version of [
		"22.18.0",
		"v22.18.0",
		"22.18.1",
		"22.22.0",
		"22.18.0+build.1",
		"22.18.1-rc.1",
		"22.19.0-beta.1",
		"24.2.0",
		"v24.22.3",
		"24.2.1-rc.1",
		"25.0.0",
		"25.0.0-rc.1",
		"26.1.0",
	]) {
		const result = checkNodeVersion(version);
		assert.equal(result.ok, true, version);
		assert.equal(result.reason, null);
		assert.equal(result.requirement, SUPPORTED_NODE_REQUIREMENT);
		assert.doesNotThrow(() => assertSupportedNodeVersion(version));
	}
});

test("非対応バージョンと境界値・不正入力を拒否し案内メッセージを返す", () => {
	for (const version of [
		"20.19.0",
		"21.7.3",
		"22.0.0",
		"22.17.99",
		"22.18.0-rc.1",
		"23.0.0",
		"23.99.0",
		"24.0.0",
		"24.1.99",
		"24.2.0-rc.1",
	]) {
		const result = checkNodeVersion(version);
		assert.equal(result.ok, false, version);
		assert.ok(result.reason?.includes(SUPPORTED_NODE_REQUIREMENT), version);
		assert.throws(
			() => assertSupportedNodeVersion(version),
			new RegExp(
				SUPPORTED_NODE_REQUIREMENT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
			),
		);
	}

	assert.match(checkNodeVersion("24.1.0").reason ?? "", /import\.meta\.main/);
	assert.match(checkNodeVersion("23.11.0").reason ?? "", /23 系/);

	for (const invalid of [
		"",
		"  ",
		"abc",
		"22.18",
		"v22.18.0.1",
		null,
		undefined,
	]) {
		assert.equal(parseNodeVersion(invalid), null);
		const result = checkNodeVersion(invalid);
		assert.equal(result.ok, false);
		assert.equal(result.version, null);
		assert.match(result.reason ?? "", /判別できません/);
	}
});

test("isMainModule は import.meta.main を優先し、未定義時はファイルパスで判別する", (t) => {
	assert.equal(
		isMainModule({ main: true, url: "file:///a.mts" }, ["node", "/b.mts"]),
		true,
	);
	assert.equal(
		isMainModule({ main: false, url: "file:///a.mts" }, ["node", "/a.mts"]),
		false,
	);

	const temp = fs.mkdtempSync(path.join(os.tmpdir(), "mdw-node-ver-test-"));
	t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
	const realFile = path.join(temp, "task.mts");
	const otherFile = path.join(temp, "other.mts");
	const linkFile = path.join(temp, "link.mts");
	fs.writeFileSync(realFile, "");
	fs.writeFileSync(otherFile, "");
	fs.symlinkSync(realFile, linkFile);

	const meta = { url: pathToFileURL(realFile).href };
	assert.equal(isMainModule(meta, ["node", realFile]), true);
	assert.equal(isMainModule(meta, ["node", linkFile]), true);
	assert.equal(isMainModule(meta, ["node", otherFile]), false);
	assert.equal(isMainModule(meta, ["node"]), false);
	assert.equal(
		isMainModule({ url: "https://example.invalid/a.mts" }, ["node", realFile]),
		false,
	);
});
