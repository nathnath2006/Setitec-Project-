"""Server-connection checks for the Settings page.

A remote profile runs real network checks (DNS, TCP, TLS for HTTPS). The Setitec API exchange itself is
not implemented yet, so that last step always reports "not available". The built-in demo profile
"connects" to the project's local dataset and reports what it holds.
"""
from __future__ import annotations

import re
import socket
import ssl
import time
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
from datetime import datetime, timezone

HOST_RE = re.compile(r"^[A-Za-z0-9.\-:\[\]]{1,253}$")


def _ms(t0: float) -> float:
    return round((time.perf_counter() - t0) * 1000, 1)


def test_remote(host: str, port: int, protocol: str, timeout: float = 3.0) -> dict:
    host = host.strip().strip("[]")
    if not HOST_RE.match(host):
        raise ValueError("Enter a host name or IP address")
    if not 1 <= port <= 65535:
        raise ValueError("Port must be between 1 and 65535")
    steps = []

    def step(key, label, status, ms=None, detail=""):
        steps.append(dict(key=key, label=label, status=status, ms=ms, detail=detail))

    t0 = time.perf_counter()
    try:
        pool = ThreadPoolExecutor(max_workers=1)
        infos = pool.submit(socket.getaddrinfo, host, port, type=socket.SOCK_STREAM).result(timeout=timeout)
        pool.shutdown(wait=False)
        addr = infos[0][4]
        step("dns", "Resolve host", "ok", _ms(t0), addr[0])
    except FutureTimeout:
        step("dns", "Resolve host", "fail", _ms(t0), f"No answer within {timeout:.0f} s")
        return _result(steps)
    except OSError as e:
        step("dns", "Resolve host", "fail", _ms(t0), e.strerror or str(e))
        return _result(steps)

    t0 = time.perf_counter()
    try:
        sock = socket.create_connection((addr[0], port), timeout=timeout)
        step("tcp", "Open TCP connection", "ok", _ms(t0), f"{addr[0]}:{port}")
    except OSError as e:
        step("tcp", "Open TCP connection", "fail", _ms(t0), getattr(e, "strerror", None) or str(e) or "timed out")
        return _result(steps)

    try:
        if protocol == "https":
            t0 = time.perf_counter()
            try:
                ctx = ssl.create_default_context()
                with ctx.wrap_socket(sock, server_hostname=host) as tls:
                    cert = tls.getpeercert() or {}
                    subject = dict(x[0] for x in cert.get("subject", ())).get("commonName", host)
                    expires = cert.get("notAfter", "")
                    step("tls", "Secure channel (TLS)", "ok", _ms(t0), f"{tls.version()} · {subject} · expires {expires}")
            except (ssl.SSLError, OSError) as e:
                step("tls", "Secure channel (TLS)", "fail", _ms(t0), str(e))
                return _result(steps)
        else:
            step("tls", "Secure channel (TLS)", "skip", None, "HTTP profile, no encryption")
    finally:
        sock.close()

    step("api", "Setitec API handshake", "unavailable", None, "Not available in this version")
    return _result(steps)


def test_demo(data: dict, query) -> dict:
    """Demo profile: reads the local dataset the way a sync would read the server."""
    steps = []
    t0 = time.perf_counter()
    n_tools = int(query("SELECT COUNT(*) AS n FROM tools")["n"].iloc[0])
    steps.append(dict(key="open", label="Open dataset", status="ok", ms=_ms(t0), detail="Data/Output Data/metadata.db"))
    t0 = time.perf_counter()
    refs = query("SELECT tool_ref FROM tools")["tool_ref"].tolist()
    steps.append(dict(key="tools", label="Read tools", status="ok", ms=_ms(t0), detail=f"{n_tools} tools · {refs[0]} … {refs[-1]}"))
    t0 = time.perf_counter()
    n_cycles = int(query("SELECT COUNT(*) AS n FROM general_infos")["n"].iloc[0])
    holes = data["holes"]
    steps.append(dict(key="cycles", label="Read cycles", status="ok", ms=_ms(t0),
                      detail=f"{n_cycles} cycles · {holes['date'].min():%d %b %Y} – {holes['date'].max():%d %b %Y}"))
    res = _result(steps)
    res.update(status="connected", tools=n_tools, cycles=n_cycles)
    return res


def _result(steps: list[dict]) -> dict:
    network_ok = all(s["status"] in ("ok", "skip", "unavailable") for s in steps) and any(s["key"] == "api" for s in steps)
    return dict(status="reachable" if network_ok else "unreachable", steps=steps,
                checked=datetime.now(timezone.utc).isoformat(timespec="seconds"))
