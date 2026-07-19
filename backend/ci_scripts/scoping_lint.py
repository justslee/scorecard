#!/usr/bin/env python3
"""CI structural guard: every ORM query against a per-user/per-owner table must
be scoped (in the SAME function) to that caller's identity.

Multi-user P0 slice 1 (specs/multiuser-p0-authz-flip-slice1.md §3 SHOULD-FIX
#4). This is the interim structural guard while `require_member` gates the
route layer but row-level scoping is what actually isolates tenants once
APP_ACCESS_MODE=open ships — this script keeps a NEW unscoped tenant query
from landing without either being fixed or explicitly, visibly exempted.

Scans backend/app/routes/, backend/app/services/, backend/app/caddie/ (AST,
not just grep) for `select(...)` / `update(...)` / `delete(...)` calls
(including aliased imports, e.g. `update as sa_update`) whose first argument
resolves to a known TENANT_MODEL (a table with an owner_id/user_id scoping
column). A hit is OK if, within the SAME enclosing function, either:
  (a) some ORM attribute access ends in `.<...>owner_id` or `.<...>user_id`
      (covers `Round.owner_id == owner_id`, `CaddiePersonaRow.author_user_id
      == user_id`, etc. — direct inline scoping), or
  (b) the function calls one of the codebase's established ownership-check
      helpers (`_get_owned_*_row(...)` / `get_owned_session(...)`) — the
      "verify the parent row once, then touch its children by the already-
      verified parent id" pattern used throughout rounds.py/tournaments.py/
      shots.py/memory.py.
Anything else is a violation UNLESS explicitly listed in EXEMPTIONS below,
with a reason. Exit 1 (and print file:line + table) on any unexplained hit.

This script deliberately does NOT scan raw `text("...")` SQL (courses_mapped.py,
pins.py's upsert, session.py's targeted JSONB updates) — matching the letter of
the slice-1 spec ("select(/update(/delete( statements"); those call sites are
either global reference data or individually reasoned about in their own
comments. A future slice can extend this script to cover raw SQL.
"""

from __future__ import annotations

import ast
import re
import sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
SCAN_DIRS = [
    BACKEND_ROOT / "app" / "routes",
    BACKEND_ROOT / "app" / "services",
    BACKEND_ROOT / "app" / "caddie",
]

# ── Tenant tables (canonical ORM class name in app/db/models.py) that MUST be
# scoped to the caller's identity wherever they're queried. ──────────────────
#
# Deliberately NOT here (and why):
#   - PlayerGroup, RoundPlayer, Score, Game, CaddieMessage: join/child tables
#     with no owner_id/user_id column of their own — scoped INDIRECTLY by
#     their parent (round_id/tournament_id) already being verified via a
#     `_get_owned_*_row`/`get_owned_session` call before these are ever
#     touched. Rule (b) below is what actually protects these; they're
#     excluded from TENANT_MODELS itself only because they have no scoping
#     column to check for in rule (a) — CaddieSession/CaddieMessage below DO
#     have a column and are listed, precisely so a future direct unscoped
#     query against them (bypassing the parent-check pattern) gets caught.
#   - ElevationCache: a global lat/lng-quantized geo cache, not per-user data.
#   - courses / tee_sets / holes / hole_yardages / hole_features: global
#     course-mapping reference data (PostGIS), authored via require_owner-
#     carved writes (courses_mapped.py) — not per-owner rows, and accessed
#     via raw SQL anyway (out of this script's scan surface, see module doc).
#   - RevokedUser (migration 017, revoked_users): the global ban list for
#     app.services.revocation — queried without caller scoping BY DESIGN (it
#     answers "is this user_id revoked", not "give me MY rows"). Do not add
#     it to TENANT_MODELS; a scoped query here would be a bug, not a fix.
TENANT_MODELS: dict[str, str] = {
    "Round": "owner_id",
    "Tournament": "owner_id",
    "Player": "owner_id",
    "GolferProfile": "user_id / owner_id",
    "ScoringCourse": "owner_id",
    "TeeTimeBooking": "owner_id",
    "CourseReview": "owner_id",
    "Shot": "user_id",
    "CaddieMemory": "user_id",
    "PlayerProfile": "user_id",
    "CaddieSession": "user_id",
    "CaddieMessage": "user_id (via the parent round's ownership)",
    # Known-deferred gaps (specs/multiuser-p0-authz-flip-slice1.md "Out of
    # scope" + the DEFERRED comment block above clerk_auth.require_member).
    # Still listed here (rather than silently excluded) so their exemptions
    # below are visible, explained, and re-checked by anyone reading this file.
    "HolePin": "user_id",
    "CaddiePersona": "author_user_id — author-scoping is a deferred gap (§3.3.4)",
}

# ── Explicit, commented exemption allowlist ───────────────────────────────────
# (relative file path, enclosing function name) -> reason. Keep this list
# SHORT and each entry justified — it is the escape hatch, not the default.
EXEMPTIONS: dict[tuple[str, str], str] = {
    ("app/caddie/session.py", "update"): (
        "SessionManager.update writes a caddie_sessions row keyed by round_id. "
        "Every caller obtains the round via get_owned_session (or /session/start's "
        "freshly-created row) before ever reaching this storage primitive — "
        "ownership is enforced one layer up, not inside this method."
    ),
    ("app/caddie/session.py", "cleanup_expired"): (
        "Background TTL sweep across ALL sessions (main.py's startup cleanup_loop). "
        "No caller identity is involved by design — it deletes any session past "
        "SESSION_TTL_SECONDS regardless of owner."
    ),
    ("app/caddie/session.py", "active_count"): (
        "Internal diagnostic count across all sessions — no caller identity involved."
    ),
    ("app/caddie/session.py", "_load_messages"): (
        "Safe only via get_owned_session — every route that reaches this helper "
        "has already verified round ownership (see get_owned_session's docstring)."
    ),
}

_SCOPED_ATTR_RE = re.compile(r"\.\w*(?:owner_id|user_id)\b")
_OWNED_HELPER_RE = re.compile(r"\b_?get_owned_\w*\s*\(")


def _iter_files() -> list[Path]:
    files: list[Path] = []
    for d in SCAN_DIRS:
        if d.is_dir():
            files.extend(sorted(d.rglob("*.py")))
    return files


def _model_import_aliases(tree: ast.AST) -> dict[str, str]:
    """local-name -> canonical ORM class name, for every `from ...db.models
    import X [as Y]` anywhere in the file (including lazy in-function imports,
    e.g. app/services/elevation.py)."""
    aliases: dict[str, str] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module and node.module.endswith("db.models"):
            for alias in node.names:
                aliases[alias.asname or alias.name] = alias.name
    return aliases


def _sqla_query_aliases(tree: ast.AST) -> dict[str, str]:
    """local-name -> canonical sqlalchemy function name (select/update/delete),
    honoring aliased imports (`update as sa_update`)."""
    aliases: dict[str, str] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module == "sqlalchemy":
            for alias in node.names:
                if alias.name in ("select", "update", "delete"):
                    aliases[alias.asname or alias.name] = alias.name
    return aliases


def _base_name(node: ast.AST) -> str | None:
    """Walk an Attribute chain (e.g. Shot.club) down to its root Name."""
    while isinstance(node, ast.Attribute):
        node = node.value
    if isinstance(node, ast.Name):
        return node.id
    return None


def _build_parent_map(tree: ast.AST) -> dict[ast.AST, ast.AST]:
    parent: dict[ast.AST, ast.AST] = {}
    for node in ast.walk(tree):
        for child in ast.iter_child_nodes(node):
            parent[child] = node
    return parent


def _enclosing_function(
    node: ast.AST, parent_map: dict[ast.AST, ast.AST]
) -> ast.FunctionDef | ast.AsyncFunctionDef | None:
    cur = node
    while cur in parent_map:
        cur = parent_map[cur]
        if isinstance(cur, (ast.FunctionDef, ast.AsyncFunctionDef)):
            return cur
    return None


def _scan_file(path: Path) -> list[str]:
    """Return a list of violation strings ("file:line: message") for this file."""
    source = path.read_text()
    try:
        tree = ast.parse(source, filename=str(path))
    except SyntaxError as exc:  # pragma: no cover - defensive
        return [f"{path}: SyntaxError while parsing for scoping_lint: {exc}"]

    model_aliases = _model_import_aliases(tree)
    query_aliases = _sqla_query_aliases(tree)
    if not query_aliases:
        return []  # file never imports select/update/delete from sqlalchemy

    parent_map = _build_parent_map(tree)
    rel = path.relative_to(BACKEND_ROOT).as_posix()
    violations: list[str] = []

    for node in ast.walk(tree):
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Name)):
            continue
        if node.func.id not in query_aliases:
            continue
        if not node.args:
            continue
        base = _base_name(node.args[0])
        if base is None:
            continue
        canonical_model = model_aliases.get(base)
        if canonical_model is None or canonical_model not in TENANT_MODELS:
            continue  # not a tenant-scoped table (or not an app.db.models import)

        func_node = _enclosing_function(node, parent_map)
        func_name = func_node.name if func_node else "<module scope>"

        if (rel, func_name) in EXEMPTIONS:
            continue

        func_source = (
            ast.get_source_segment(source, func_node) if func_node else source
        )
        func_source = func_source or ""
        if _SCOPED_ATTR_RE.search(func_source) or _OWNED_HELPER_RE.search(func_source):
            continue

        violations.append(
            f"{rel}:{node.lineno}: {query_aliases[node.func.id]}({canonical_model}) "
            f"in {func_name}() has no owner/user scoping in the same function "
            f"(column: {TENANT_MODELS[canonical_model]}). Add a "
            f".where(...{TENANT_MODELS[canonical_model].split()[0]}...) filter, "
            f"route through an existing get_owned_*/_get_owned_*_row helper, or "
            f"add a commented entry to EXEMPTIONS in ci_scripts/scoping_lint.py "
            f"with a real reason."
        )

    return violations


def main() -> int:
    all_violations: list[str] = []
    for path in _iter_files():
        all_violations.extend(_scan_file(path))

    if all_violations:
        print("scoping_lint: unscoped tenant queries found:\n")
        for v in all_violations:
            print(f"  {v}")
        print(
            f"\n{len(all_violations)} violation(s). See the module docstring in "
            "ci_scripts/scoping_lint.py for how to fix or exempt."
        )
        return 1

    print(f"scoping_lint: clean ({len(_iter_files())} files scanned).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
