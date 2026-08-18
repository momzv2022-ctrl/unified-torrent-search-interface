"""Static scan applied to every plugin before it is written to disk.

This is a cheap tripwire, **not** a sandbox. It catches the obvious — a plugin
that shells out, unpickles, or opens a raw socket — and it records the set of
hosts a plugin talks to so the daily bot can flag the day one of them changes.
The real containment is the subprocess in `runner.py`.

Two severities, and the difference matters:

* **deny** — the file is rejected outright and never lands in the engines dir.
* **host** — informational. Plugins legitimately hit more hosts than the one
  they declare (piratebay declares thepiratebay.org and calls apibay.org), so
  a foreign host is a review signal rather than a verdict. Set
  ``UTSI_STRICT_HOSTS=1`` to make undeclared hosts fatal.
"""

from __future__ import annotations

import ast
import re
import warnings
from dataclasses import dataclass, field
from urllib.parse import urlsplit

#: Modules a search plugin has no business importing. `helpers.retrieve_url()`
#: is the sanctioned way to reach the network.
DENIED_MODULES = frozenset({
    "socket",
    "socketserver",
    "subprocess",
    "pickle",
    "cPickle",
    "marshal",
    "shelve",
    "ctypes",
    "pty",
    "fcntl",
    "resource",
    "multiprocessing.connection",
})

#: Bare callables that turn data into code.
DENIED_BUILTINS = frozenset({"eval", "exec", "compile", "__import__", "breakpoint"})

#: `module.attribute` pairs that spawn processes or load code.
DENIED_ATTRIBUTES = frozenset({
    ("os", "system"),
    ("os", "popen"),
    ("os", "execl"), ("os", "execle"), ("os", "execlp"), ("os", "execv"),
    ("os", "execve"), ("os", "execvp"), ("os", "execvpe"),
    ("os", "spawnl"), ("os", "spawnv"), ("os", "spawnve"),
    ("os", "fork"), ("os", "forkpty"),
    ("importlib", "import_module"),
    ("builtins", "eval"), ("builtins", "exec"),
})

_URL = re.compile(r"""["'](?:https?|udp|wss?)://([^/"'\s:]+)""", re.IGNORECASE)

#: Hosts every plugin may reference: trackers embedded in synthesised magnets
#: and the handful of CDNs plugins fetch favicons or mirror lists from.
ALWAYS_ALLOWED_HOSTS = frozenset({
    "localhost",
    "127.0.0.1",
})


@dataclass(slots=True)
class Finding:
    severity: str  # "deny" | "host"
    code: str
    detail: str
    line: int = 0

    def __str__(self) -> str:
        where = f":{self.line}" if self.line else ""
        return f"[{self.severity}] {self.code}{where} {self.detail}"


@dataclass(slots=True)
class ScanResult:
    ok: bool
    findings: list[Finding] = field(default_factory=list)
    hosts: list[str] = field(default_factory=list)
    declared_class: bool = False
    declared_url: str = ""

    @property
    def denials(self) -> list[Finding]:
        return [f for f in self.findings if f.severity == "deny"]

    def summary(self) -> str:
        return "; ".join(str(f) for f in self.denials) or "ok"


def _class_url(node: ast.ClassDef) -> str:
    """The `url = "https://…"` a nova3 engine class is required to declare."""
    for item in node.body:
        targets = (
            item.targets if isinstance(item, ast.Assign)
            else [item.target] if isinstance(item, ast.AnnAssign)
            else []
        )
        for target in targets:
            if isinstance(target, ast.Name) and target.id == "url":
                value = item.value
                if isinstance(value, ast.Constant) and isinstance(value.value, str):
                    return value.value
    return ""


def _find_engine_class(tree: ast.Module, module_name: str) -> ast.ClassDef | None:
    """The class `_shim._engine_class()` will instantiate, if there is one.

    nova3 itself demands `class <module_name>`, but the shim also accepts a
    case-insensitive match or a lone class implementing `search()`, so the scan
    must not reject what the runner can in fact load.
    """
    classes = [node for node in tree.body if isinstance(node, ast.ClassDef)]
    for node in classes:
        if node.name.lower() == module_name.lower():
            return node
    searchable = [
        node
        for node in classes
        if any(
            isinstance(item, ast.FunctionDef | ast.AsyncFunctionDef) and item.name == "search"
            for item in node.body
        )
    ]
    return searchable[0] if len(searchable) == 1 else None


class _Visitor(ast.NodeVisitor):
    def __init__(self, module_name: str) -> None:
        self.module_name = module_name
        self.findings: list[Finding] = []

    def _deny(self, node: ast.AST, code: str, detail: str) -> None:
        self.findings.append(Finding("deny", code, detail, getattr(node, "lineno", 0)))

    def visit_Import(self, node: ast.Import) -> None:
        for alias in node.names:
            self._check_module(node, alias.name)
        self.generic_visit(node)

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        if node.module:
            self._check_module(node, node.module)
        self.generic_visit(node)

    def _check_module(self, node: ast.AST, name: str) -> None:
        parts = name.split(".")
        for depth in range(1, len(parts) + 1):
            candidate = ".".join(parts[:depth])
            if candidate in DENIED_MODULES:
                self._deny(node, "denied-import", candidate)
                return

    def visit_Call(self, node: ast.Call) -> None:
        target = node.func
        if isinstance(target, ast.Name) and target.id in DENIED_BUILTINS:
            self._deny(node, "denied-call", target.id)
        elif isinstance(target, ast.Attribute) and isinstance(target.value, ast.Name):
            pair = (target.value.id, target.attr)
            if pair in DENIED_ATTRIBUTES:
                self._deny(node, "denied-call", f"{pair[0]}.{pair[1]}")
        self.generic_visit(node)

    def visit_Attribute(self, node: ast.Attribute) -> None:
        # `getattr(o, "__globals__")` style escapes are out of scope for a cheap
        # scan, but the direct dunder reach-arounds are worth catching.
        if node.attr in ("__globals__", "__builtins__", "__subclasses__", "__reduce__"):
            self._deny(node, "dunder-access", node.attr)
        self.generic_visit(node)


def _hosts_in(source: str) -> list[str]:
    seen: set[str] = set()
    for match in _URL.finditer(source):
        host = match.group(1).lower().lstrip(".")
        if host and not host.startswith("%") and "{" not in host:
            seen.add(host)
    return sorted(seen)


def _registrable(host: str) -> str:
    """Crude eTLD+1 so `apibay.org` and `www.apibay.org` compare equal."""
    parts = host.split(".")
    return ".".join(parts[-2:]) if len(parts) >= 2 else host


def scan(
    source: str,
    module_name: str,
    *,
    declared_url: str = "",
    allowed_hosts: tuple[str, ...] = (),
    strict_hosts: bool = False,
) -> ScanResult:
    """Inspect plugin *source*; ``ScanResult.ok`` is False when it must not run."""
    try:
        with warnings.catch_warnings():
            # Parsing third-party source makes the compiler lint it at us —
            # unescaped regex literals are endemic in the plugin ecosystem, and
            # those diagnostics belong to the plugin's author, not the operator
            # reading our log. (SyntaxWarning on 3.12+, DeprecationWarning before.)
            warnings.simplefilter("ignore", SyntaxWarning)
            warnings.simplefilter("ignore", DeprecationWarning)
            tree = ast.parse(source, filename=f"{module_name}.py")
    except SyntaxError as exc:
        return ScanResult(ok=False, findings=[Finding("deny", "syntax-error", str(exc), exc.lineno or 0)])

    visitor = _Visitor(module_name)
    visitor.visit(tree)
    findings = list(visitor.findings)

    engine_class = _find_engine_class(tree, module_name)
    if engine_class is None:
        findings.append(
            Finding("deny", "missing-class", f"no class implementing search() for {module_name!r}")
        )
    # The engine's own `url` attribute is a better declaration than anything a
    # third party recorded about it, so prefer it and accept both.
    self_declared = _class_url(engine_class) if engine_class is not None else ""

    hosts = _hosts_in(source)
    permitted = {_registrable(h) for h in allowed_hosts} | ALWAYS_ALLOWED_HOSTS
    for candidate in (self_declared, declared_url):
        host = urlsplit(candidate).hostname if candidate else None
        if host:
            permitted.add(_registrable(host))

    for host in hosts:
        if _registrable(host) not in permitted:
            findings.append(Finding("deny" if strict_hosts else "host", "foreign-host", host))

    ok = not any(f.severity == "deny" for f in findings)
    return ScanResult(
        ok=ok,
        findings=findings,
        hosts=hosts,
        declared_class=engine_class is not None,
        declared_url=self_declared,
    )
