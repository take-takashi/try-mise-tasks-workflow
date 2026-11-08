"""MDWのレビュー処理が共有する機能。"""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

# miseはタスクを定義したプロジェクトから実行するため、呼び出し元を別に保持する。
ROOT = Path(os.environ.get("MISE_ORIGINAL_CWD") or Path.cwd()).resolve()
OUTPUT = ROOT / ".reviews"
ROLES = {
    "security": "認証、認可、入力処理、情報漏えいなどのセキュリティ上の欠陥",
    "quality": "正しさ、回帰、例外処理、テスト不足などの品質上の欠陥",
}
FINDING_FIELDS = ("severity", "file", "line", "title", "evidence", "recommendation")
SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["findings", "limitations", "file_coverage"],
    "properties": {
        "limitations": {"type": "array", "items": {"type": "string", "minLength": 1}},
        "file_coverage": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["file", "status", "detail"],
                "properties": {
                    "file": {"type": "string", "minLength": 1},
                    "status": {"type": "string", "enum": ["reviewed", "unreadable"]},
                    "detail": {"type": "string", "minLength": 1},
                },
            },
        },
        "findings": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": list(FINDING_FIELDS),
                "properties": {
                    "severity": {"type": "string", "enum": ["critical", "high", "medium", "low"]},
                    "file": {"type": "string", "minLength": 1},
                    "line": {"type": "integer", "minimum": 1},
                    "title": {"type": "string", "minLength": 1},
                    "evidence": {"type": "string", "minLength": 1},
                    "recommendation": {"type": "string", "minLength": 1},
                },
            },
        },
    },
}


def run(command, *, env=None, input_text=None, timeout=600):
    try:
        result = subprocess.run(command, cwd=ROOT, env=env, input=input_text,
                                capture_output=True, text=True, encoding="utf-8",
                                timeout=timeout, check=False, shell=False)
    except (OSError, UnicodeError, subprocess.TimeoutExpired) as exc:
        raise ValueError(f"{command[0]} の実行に失敗しました: {type(exc).__name__}") from exc
    if result.returncode:
        # CLIの出力には認証情報が含まれる可能性があるため表示しない。
        raise ValueError(f"{command[0]} が終了コード {result.returncode} で失敗しました。CLIの認証、モデル、設定を確認してください。")
    return result


def read_json(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"{path.name} を読み取れません: {type(exc).__name__}") from exc


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(dir=path.parent, prefix=".tmp-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(data, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def validate_review(data):
    if (not isinstance(data, dict) or set(data) != {"findings", "limitations", "file_coverage"}
            or not isinstance(data["findings"], list) or not isinstance(data["limitations"], list)
            or not isinstance(data["file_coverage"], list)):
        raise ValueError("レビュー結果の findings、limitations、file_coverage が不正です。")
    if any(not isinstance(item, str) or not item.strip() for item in data["limitations"]):
        raise ValueError("レビューの確認できなかった範囲が不正です。")
    for item in data["file_coverage"]:
        if (not isinstance(item, dict) or set(item) != {"file", "status", "detail"}
                or any(not isinstance(item[key], str) or not item[key].strip() for key in ("file", "detail"))
                or item["status"] not in ("reviewed", "unreadable")):
            raise ValueError("ファイルごとの確認状況が不正です。")
    for finding in data["findings"]:
        if not isinstance(finding, dict) or set(finding) != set(FINDING_FIELDS):
            raise ValueError("指摘のフィールドが不正です。")
        if finding["severity"] not in ("critical", "high", "medium", "low"):
            raise ValueError("指摘の severity が不正です。")
        if type(finding["line"]) is not int or finding["line"] < 1:
            raise ValueError("指摘の行番号が不正です。")
        if any(not isinstance(finding[key], str) or not finding[key].strip()
               for key in ("file", "title", "evidence", "recommendation")):
            raise ValueError("指摘の文字列フィールドが不正です。")


def initialize_root():
    global ROOT, OUTPUT
    ROOT = Path(run(["git", "rev-parse", "--show-toplevel"], timeout=30).stdout.strip()).resolve()
    OUTPUT = ROOT / ".reviews"


def config(role):
    prefix = f"MDW_REVIEW_{role.upper()}_"
    provider = resolve_review_setting(role, "PROVIDER", "codex")
    model = resolve_review_setting(role, "MODEL", "gpt-6.1-sol")
    effort = resolve_review_setting(role, "EFFORT", "medium")
    billing = resolve_review_setting(role, "BILLING", "subscription")
    if provider not in ("codex", "claude") or not model or billing not in ("subscription", "api"):
        raise ValueError(f"{prefix}PROVIDER、MODEL、BILLING の設定が不正です。MDW_REVIEW_* またはAWF_REVIEW_*を確認してください。")
    if provider == "codex" and billing != "subscription":
        raise ValueError("CodexのAPI課金はこのPoCでは対応していません。")
    supported_efforts = {
        "codex": {"none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"},
        "claude": {"low", "medium", "high", "xhigh", "max", "ultracode"},
    }
    if effort not in supported_efforts[provider]:
        raise ValueError(f"{prefix}EFFORT は {provider} に対応する値を指定してください。")
    executable = shutil.which(provider)
    if not executable:
        raise ValueError(f"{provider} CLI が見つかりません。")
    return provider, model, effort, billing, executable


def child_environment(provider, billing):
    env = os.environ.copy()
    api_key = env.pop("MDW_ANTHROPIC_API_KEY", "")
    legacy_api_key = env.pop("AWF_ANTHROPIC_API_KEY", "")
    api_key = api_key or legacy_api_key
    env.pop("REVIEW_ANTHROPIC_API_KEY", None)
    forbidden = ("OPENAI_API_KEY", "CODEX_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN",
                 "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX",
                 "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_USE_GATEWAY")
    for key in forbidden:
        env.pop(key, None)
    if provider == "claude" and billing == "api":
        if not api_key:
            raise ValueError("Claude APIには MDW_ANTHROPIC_API_KEY が必要です。")
        env["ANTHROPIC_API_KEY"] = api_key
    return env


def resolve_review_setting(role, field, default):
    """レビュー設定を個別設定、旧AWF設定、共通設定、既定値の順に解決する。"""
    role = role.upper()
    field = field.upper()
    names = (
        f"MDW_REVIEW_{role}_{field}",
        # 既存利用者のmise.local.tomlなどにあるAWF設定を引き続き受け付ける。
        f"AWF_REVIEW_{role}_{field}",
        f"MDW_REVIEW_{field}",
        f"MDW_DEFAULT_{field}",
    )
    for name in names:
        value = os.environ.get(name)
        if value is not None and value.strip():
            return value
    return default


def check_auth(provider, billing, executable, env):
    if provider == "codex":
        result = run([executable, "login", "status"], env=env, timeout=30)
        if "Logged in using ChatGPT" not in result.stdout + result.stderr:
            raise ValueError("CodexのChatGPT認証を確認できません。")
    else:
        result = run([executable, "auth", "status"], env=env, timeout=30)
        try:
            status = json.loads(result.stdout)
        except json.JSONDecodeError as exc:
            raise ValueError("Claudeの認証状態を読み取れません。") from exc
        expected = "api_key" if billing == "api" else "claude.ai"
        if not isinstance(status, dict) or status.get("authMethod") != expected:
            raise ValueError(f"Claudeの認証方式が指定した {billing} と一致しません。")


def check():
    timeout_seconds()
    for role in ROLES:
        provider, model, effort, billing, executable = config(role)
        check_auth(provider, billing, executable, child_environment(provider, billing))
        print(f"{role}: {provider} の設定と認証を確認しました。", flush=True)


def timeout_seconds():
    try:
        timeout = int(os.environ.get("MDW_REVIEW_TIMEOUT_SECONDS", os.environ.get("AWF_REVIEW_TIMEOUT_SECONDS", "600")))
    except ValueError as exc:
        raise ValueError("MDW_REVIEW_TIMEOUT_SECONDS は正の整数を指定してください。") from exc
    if timeout < 1:
        raise ValueError("MDW_REVIEW_TIMEOUT_SECONDS は正の整数を指定してください。")
    return timeout


def review(role, manifest):
    started = time.perf_counter()
    provider, model, effort, billing, executable = config(role)
    env = child_environment(provider, billing)
    before = manifest["merge_base_commit"]
    after = manifest["head_commit"]
    files = json.dumps(manifest["changed_files"], ensure_ascii=False)
    prompt = (f"コミット {before} から {after} までの変更を、{ROLES[role]}の観点でレビューしてください。\n"
              f"変更ファイルの一覧（binaryはGitがバイナリーと判定したファイル）: {files}\n"
              f"まず git diff --no-ext-diff --no-textconv --no-renames {before} {after} -- でコミット間の差分を確認し、"
              "必要な場合は git show <コミットID>:<パス> を使って変更前後の内容、周辺コードやテストを確認してください。"
              "作業ツリーやインデックスの未コミット変更をレビュー対象に含めないでください。"
              "一覧のすべてのファイルについて、file_coverageにfile、確認できたかを示すstatus（reviewedまたはunreadable）、"
              "確認方法または確認できなかった理由を示すdetailを記録してください。"
              "Gitがバイナリーと扱う場合は差分だけで判断せず、可能ならコミット内の内容を取得して確認してください。"
              "テキストの文字コードが異なる場合も可能な範囲で確認してください。"
              "読み取れないファイル、ツールの権限や出力制限などで確認できなかった範囲はlimitationsに記載し、"
              "確認できなかったものを確認済みとして扱わないでください。"
              "確認できなかった範囲がなければlimitationsは空配列としてください。"
              "変更に起因する具体的な問題だけを報告し、該当しなければfindingsを空配列にしてください。"
              "ファイルを変更せず、日本語で出力してください。")
    timeout = timeout_seconds()
    schema = json.dumps(SCHEMA, ensure_ascii=False)
    if provider == "codex":
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            schema_file = directory / "schema.json"
            schema_file.write_text(schema, encoding="utf-8")
            result_file = directory / "response.json"
            command = [executable, "exec", "--ignore-user-config", "-c", 'model_provider="openai"',
                       "-c", f"model_reasoning_effort={json.dumps(effort)}",
                       "--sandbox", "read-only", "--ephemeral", "--model", model,
                       "--output-schema", str(schema_file), "-o", str(result_file), "-"]
            run(command, env=env, input_text=prompt, timeout=timeout)
            data = read_json(result_file)
    else:
        command = [executable, "-p", "--model", model, "--effort", effort,
                   "--tools", "Read,Grep,Glob,Bash", "--permission-mode", "plan", "--strict-mcp-config",
                   "--no-chrome", "--no-session-persistence", "--output-format", "json",
                   "--json-schema", schema]
        result = run(command, env=env, input_text=prompt, timeout=timeout)
        try:
            envelope = json.loads(result.stdout)
            if envelope.get("is_error") or "structured_output" not in envelope:
                raise ValueError("Claudeの構造化出力がありません。")
            data = envelope["structured_output"]
            denials = envelope.get("permission_denials", [])
            if denials:
                validate_review(data)
                data["limitations"].append(f"Claudeのツール使用が{len(denials)}件拒否されました。")
        except (json.JSONDecodeError, AttributeError) as exc:
            raise ValueError("Claudeの出力が不正なJSONです。") from exc
    validate_review(data)
    expected = {item["path"] for item in manifest["changed_files"]}
    coverage = {item["file"]: item for item in data["file_coverage"]}
    if len(coverage) != len(data["file_coverage"]):
        data["limitations"].append("同じファイルの確認状況が重複して報告されました。")
    for path in sorted(expected - coverage.keys()):
        data["limitations"].append(f"{path}: エージェントが確認状況を報告しませんでした。")
    for path in sorted(coverage.keys() - expected):
        data["limitations"].append(f"{path}: 報告されたファイルは変更ファイル一覧にありません。")
    for item in manifest["changed_files"]:
        path = item["path"]
        if path in coverage and coverage[path]["status"] == "unreadable":
            data["limitations"].append(f"{path}: 内容を確認できませんでした。")
        if item["path_encoding_error"]:
            data["limitations"].append(f"{path}: ファイル名をUTF-8で読み取れませんでした。")
        if item["binary"]:
            data["limitations"].append(f"{path}: Gitがバイナリーと判定しました。確認状況はモデルの申告です。")
    if read_json(OUTPUT / "manifest.json") != manifest:
        raise ValueError("レビューの実行中に対象が変更されました。")
    duration = round(time.perf_counter() - started, 3)
    result = {"reviewer_id": role, "provider": provider, "model": model,
              "effort": effort, "billing": billing, "duration_seconds": duration,
              "target": manifest, "review": data}
    write_json(OUTPUT / f"{role}.json", result)
    print(f"{role}: {len(data['findings'])} 件の指摘、{len(data['limitations'])} 件の制限を保存しました（{duration:.3f}秒）。", flush=True)
    return result
