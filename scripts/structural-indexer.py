#!/usr/bin/env python3
"""JSON-RPC structural extractor backed by tree-sitter-language-pack.

The TypeScript caller treats this subprocess as optional and falls back to its
own regex extractor when Python or tree-sitter-language-pack is unavailable.
"""

from __future__ import annotations

import json
import re
import sys
import uuid
from typing import Any


try:
    from tree_sitter_language_pack import get_parser  # type: ignore
except Exception as exc:  # pragma: no cover - depends on local Python env
    print(json.dumps({
        "jsonrpc": "2.0",
        "id": None,
        "error": {"code": -32000, "message": f"tree-sitter-language-pack unavailable: {exc}"},
    }))
    sys.exit(1)


SYMBOL_NODES = {
    "typescript": {
        "function_declaration": "function",
        "class_declaration": "class",
        "interface_declaration": "interface",
        "type_alias_declaration": "type",
        "method_definition": "method",
    },
    "javascript": {
        "function_declaration": "function",
        "class_declaration": "class",
        "method_definition": "method",
    },
    "python": {
        "function_definition": "function",
        "class_definition": "class",
    },
    "rust": {
        "function_item": "function",
        "struct_item": "struct",
        "enum_item": "enum",
        "trait_item": "trait",
        "mod_item": "module",
        "const_item": "constant",
        "static_item": "variable",
    },
    "go": {
        "function_declaration": "function",
        "method_declaration": "method",
        "type_spec": "type",
    },
    "java": {
        "class_declaration": "class",
        "interface_declaration": "interface",
        "enum_declaration": "enum",
        "method_declaration": "method",
    },
}

CONTROL_WORDS = {
    "if", "for", "while", "switch", "catch", "return", "throw", "else", "try",
    "do", "new", "function", "class", "interface", "type", "const", "let",
    "var", "pub", "fn", "func", "def", "elif", "except", "finally", "with",
    "lambda", "await", "yield",
}

IGNORED_CALL_TARGETS = {
    *CONTROL_WORDS,
    "console", "log", "debug", "info", "warn", "error", "require", "import",
    "super",
}


def normalize_identifier(value: str) -> str:
    return re.sub(r"[^a-z0-9_$./:-]", "", value.lower())


def normalize_symbol(value: str) -> str:
    return re.sub(r"[^a-z0-9_$]", "", value.lower())


def node_text(source: bytes, node: Any) -> str:
    return source[node.start_byte:node.end_byte].decode("utf-8", errors="replace")


def child_name(source: bytes, node: Any) -> str | None:
    child = node.child_by_field_name("name")
    if child is not None:
        return node_text(source, child)
    for candidate in node.children:
        if candidate.type in {"identifier", "type_identifier", "field_identifier"}:
            return node_text(source, candidate)
    return None


def exported(source: bytes, node: Any, language: str) -> bool:
    line_start = source.rfind(b"\n", 0, node.start_byte) + 1
    line = source[line_start:node.start_byte].decode("utf-8", errors="ignore")
    if language in {"typescript", "javascript"}:
        return "export" in line
    if language == "rust":
        return "pub" in line
    if language == "java":
        return "public" in line
    return False


def extract_symbols(text: str, language: str, path: str | None) -> list[dict[str, Any]]:
    parser = get_parser(language)
    source = text.encode("utf-8")
    tree = parser.parse(source)
    kinds = SYMBOL_NODES.get(language, {})
    symbols: list[dict[str, Any]] = []
    seen: set[tuple[str, str, int]] = set()

    def visit(node: Any) -> None:
        kind = kinds.get(node.type)
        if kind:
            name = child_name(source, node)
            if name:
                start_line = node.start_point[0] + 1
                key = (kind, name, start_line)
                if key not in seen:
                    seen.add(key)
                    signature = node_text(source, node).splitlines()[0].strip()
                    symbols.append({
                        "id": str(uuid.uuid4()),
                        "path": path,
                        "language": language,
                        "name": name,
                        "normalizedName": normalize_symbol(name),
                        "kind": kind,
                        "signature": signature,
                        "startLine": start_line,
                        "endLine": node.end_point[0] + 1,
                        "isExported": exported(source, node, language),
                        "metadata": {"nodeType": node.type},
                    })
        for child in node.children:
            visit(child)

    visit(tree.root_node)
    return symbols


def extract_references(text: str, language: str, path: str | None) -> list[dict[str, Any]]:
    references: list[dict[str, Any]] = []
    patterns: list[tuple[str, str]] = []
    if language in {"typescript", "javascript"}:
        patterns = [
            (r"\bfrom\s+['\"]([^'\"]+)['\"]", "import"),
            (r"\bimport\s*\(\s*['\"]([^'\"]+)['\"]\s*\)", "import"),
            (r"\brequire\s*\(\s*['\"]([^'\"]+)['\"]\s*\)", "import"),
            (r"^\s*import\s+['\"]([^'\"]+)['\"]", "import"),
            (r"^export\s+\*\s+from\s+['\"]([^'\"]+)['\"]", "export"),
        ]
    elif language == "python":
        patterns = [
            (r"^from\s+([\w.]+|\.+[\w.]*)\s+import\s+", "import"),
            (r"^import\s+([\w.]+)", "import"),
        ]
    elif language == "rust":
        patterns = [
            (r"^(?:pub\s+)?use\s+(.+?);?$", "import"),
            (r"^pub\s+use\s+(.+?);?$", "export"),
            (r"^(?:pub\s+)?mod\s+(\w+)", "module"),
        ]
    elif language == "go":
        patterns = [(r"^import\s+(?:\w+\s+)?[\"`]([^\"`]+)[\"`]", "import"), (r"^(?:\w+\s+)?[\"`]([^\"`]+)[\"`]$", "import")]
    elif language == "java":
        patterns = [(r"^import\s+(?:static\s+)?([\w.]*\*?)\s*;", "import")]

    seen: set[tuple[str, str, int]] = set()

    def add_reference(target: str, kind: str, line_number: int, metadata: dict[str, Any] | None = None) -> None:
        target = target.strip()
        if not target:
            return
        key = (kind, target, line_number)
        if key in seen:
            return
        seen.add(key)
        references.append({
            "id": str(uuid.uuid4()),
            "path": path,
            "language": language,
            "target": target,
            "normalizedTarget": normalize_identifier(target),
            "kind": kind,
            "startLine": line_number,
            "endLine": line_number,
            "metadata": metadata or {},
        })

    for line_number, line in enumerate(text.splitlines(), start=1):
        stripped = line.strip()
        for pattern, kind in patterns:
            for match in re.finditer(pattern, stripped):
                add_reference(match.group(1), kind, line_number)
        if language in {"typescript", "javascript"}:
            extract_js_regex_references(stripped, line_number, add_reference)
        elif language == "python":
            extract_python_regex_references(stripped, line_number, add_reference)
        elif language == "java":
            extract_java_regex_references(stripped, line_number, add_reference)
        extract_call_references(stripped, language, line_number, add_reference)
    return references


def extract_js_regex_references(line: str, line_number: int, add_reference: Any) -> None:
    named_export = re.match(r"^export\s+(?:type\s+)?\{([^}]+)\}(?:\s+from\s+['\"]([^'\"]+)['\"])?", line)
    if named_export:
        names = split_export_list(named_export.group(1))
        for name in names:
            add_reference(name, "export", line_number)
        if named_export.group(2):
            add_reference(named_export.group(2), "export", line_number, {"exports": names})

    declaration_export = re.match(
        r"^export\s+(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|var)\s+([A-Za-z_$][\w$]*)",
        line,
    )
    if declaration_export:
        add_reference(declaration_export.group(1), "export", line_number)

    extends_match = re.search(r"\bextends\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)", line)
    if extends_match:
        add_reference(extends_match.group(1), "inheritance", line_number)

    implements_match = re.search(r"\bimplements\s+([^{]+)", line)
    if implements_match:
        add_reference_list(implements_match.group(1), "inheritance", line_number, add_reference)


def extract_python_regex_references(line: str, line_number: int, add_reference: Any) -> None:
    for export_match in re.finditer(r"__all__\s*=\s*\[([^\]]*)\]", line):
        for name in re.findall(r"['\"]([A-Za-z_][\w]*)['\"]", export_match.group(1)):
            add_reference(name, "export", line_number)

    bases = re.match(r"^class\s+[A-Za-z_][\w]*\s*\(([^)]*)\)", line)
    if bases:
        add_reference_list(bases.group(1), "inheritance", line_number, add_reference)


def extract_java_regex_references(line: str, line_number: int, add_reference: Any) -> None:
    extends_match = re.search(r"\bextends\s+([A-Za-z_][\w.]*)", line)
    if extends_match:
        add_reference(extends_match.group(1), "inheritance", line_number)

    implements_match = re.search(r"\bimplements\s+([^{]+)", line)
    if implements_match:
        add_reference_list(implements_match.group(1), "inheritance", line_number, add_reference)

    public_symbol = re.match(
        r"^public\s+(?:abstract\s+|final\s+)?(?:(?:class|interface|enum)\s+|[\w_<>\[\], ?]+\s+)([A-Za-z_][\w]*)\b",
        line,
    )
    if public_symbol:
        add_reference(public_symbol.group(1), "export", line_number)


def extract_call_references(line: str, language: str, line_number: int, add_reference: Any) -> None:
    code = strip_comments(strip_strings(line), language)
    for match in re.finditer(r"\b([A-Za-z_$][\w$]*(?:(?:\.|::)[A-Za-z_$][\w$]*)*)\s*\(", code):
        target = match.group(1)
        parts = re.split(r"\.|::", target)
        root = parts[0].lower()
        leaf = parts[-1]
        prefix = code[max(0, match.start() - 18):match.start()]
        if re.search(r"\b(?:function|def|fn|func|class|interface|type)\s+$", prefix):
            continue
        if is_method_definition_at(code, match.start()):
            continue
        if root in IGNORED_CALL_TARGETS or leaf.lower() in IGNORED_CALL_TARGETS:
            continue
        if target.startswith("this.") or target.startswith("self."):
            add_reference(leaf, "call", line_number, {"receiver": parts[0]})
            continue
        add_reference(target, "call", line_number)


def is_method_definition_at(code: str, start: int) -> bool:
    suffix = code[start:]
    if not re.match(r"[A-Za-z_$][\w$]*\s*\([^;{}]*\)\s*(?::\s*[^={]+)?\s*\{", suffix):
        return False
    prefix = code[:start].strip()
    return not prefix.endswith(("return", "=", "=>", ".", "::", "new"))


def split_export_list(value: str) -> list[str]:
    names: list[str] = []
    for part in value.split(","):
        name = re.sub(r"^type\s+", "", part.strip()).split(" as ")[0].strip()
        if name:
            names.append(name)
    return names


def add_reference_list(value: str, kind: str, line_number: int, add_reference: Any) -> None:
    for part in value.split(","):
        target = re.sub(r"\bas\s+[A-Za-z_$][\w$]*", "", part)
        target = re.sub(r"\bextends\b|\bimplements\b", "", target)
        target = re.sub(r"[<>{}()[\];]", " ", target).strip().split()
        if target:
            add_reference(target[0], kind, line_number)


def strip_strings(value: str) -> str:
    value = re.sub(r"'(?:\\.|[^'\\])*'", "''", value)
    value = re.sub(r'"(?:\\.|[^"\\])*"', '""', value)
    return re.sub(r"`(?:\\.|[^`\\])*`", "``", value)


def strip_comments(value: str, language: str) -> str:
    if language == "python":
        return re.sub(r"#.*", "", value)
    return re.sub(r"//.*", "", value)


def handle(request: dict[str, Any]) -> dict[str, Any]:
    request_id = request.get("id")
    params = request.get("params") or {}
    text = params.get("text") or ""
    language = (params.get("language") or "").lower()
    path = params.get("path")
    if request.get("method") != "extract":
        return {"jsonrpc": "2.0", "id": request_id, "error": {"code": -32601, "message": "unknown method"}}
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "result": {
            "symbols": extract_symbols(text, language, path),
            "references": extract_references(text, language, path),
        },
    }


def main() -> int:
    raw = sys.stdin.read()
    try:
        request = json.loads(raw)
        print(json.dumps(handle(request)))
        return 0
    except Exception as exc:
        print(json.dumps({
            "jsonrpc": "2.0",
            "id": None,
            "error": {"code": -32000, "message": str(exc)},
        }))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
