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
            (r"\brequire\s*\(\s*['\"]([^'\"]+)['\"]\s*\)", "import"),
            (r"^\s*import\s+['\"]([^'\"]+)['\"]", "import"),
        ]
    elif language == "python":
        patterns = [(r"^from\s+([\w.]+)\s+import\s+", "import"), (r"^import\s+([\w.]+)", "import")]
    elif language == "rust":
        patterns = [(r"^(?:pub\s+)?use\s+(.+?);?$", "import"), (r"^(?:pub\s+)?mod\s+(\w+)", "module")]
    elif language == "go":
        patterns = [(r"^import\s+(?:\w+\s+)?[\"`]([^\"`]+)[\"`]", "import"), (r"^(?:\w+\s+)?[\"`]([^\"`]+)[\"`]$", "import")]
    elif language == "java":
        patterns = [(r"^import\s+(?:static\s+)?([\w.]*\*?)\s*;", "import")]

    seen: set[tuple[str, str, int]] = set()
    for line_number, line in enumerate(text.splitlines(), start=1):
        stripped = line.strip()
        for pattern, kind in patterns:
            for match in re.finditer(pattern, stripped):
                target = match.group(1).strip()
                key = (kind, target, line_number)
                if key in seen:
                    continue
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
                    "metadata": {},
                })
    return references


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
