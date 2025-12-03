from __future__ import annotations

import os
from typing import Any, Dict, List, Optional

import httpx
from bs4 import BeautifulSoup
from mcp.server.fastmcp import FastMCP
import uvicorn


# --- DuckDuckGo HTML search helpers -------------------------------------------------


def _create_http_client() -> httpx.Client:
    """
    Create an HTTPX client with optional proxy support via standard env vars.
    """
    # httpx respects standard HTTP(S)_PROXY / NO_PROXY environment variables by default,
    # so we do not need to configure a proxy explicitly here. We only set a timeout.
    return httpx.Client(timeout=15.0)


def duckduckgo_search(query: str, limit: int = 5) -> List[Dict[str, str]]:
    """
    Perform a DuckDuckGo HTML search and scrape results.

    This mirrors the Node.js implementation used in the former TypeScript MCP server:
    - Endpoint: https://html.duckduckgo.com/html/
    - User-Agent / Accept headers are set appropriately to look like a real browser
    """
    if limit <= 0:
        return []

    client = _create_http_client()

    try:
        resp = client.get(
            "https://html.duckduckgo.com/html/",
            params={"q": query, "s": "0"},
            headers={
                "User-Agent": (
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/120.0.0.0 Safari/537.36"
                ),
                "Accept": (
                    "text/html,application/xhtml+xml,application/xml;q=0.9,"
                    "image/webp,*/*;q=0.8"
                ),
                "Accept-Language": "en-US,en;q=0.5",
                # As in the original Node implementation, force identity encoding to avoid
                # issues with compressed responses when going through some proxies.
                "Accept-Encoding": "identity",
                "Referer": "https://duckduckgo.com/",
            },
        )
        resp.raise_for_status()
    except Exception as e:  # noqa: BLE001
        # Keep error handling simple here; the MCP tool will return this as a message.
        return [
            {
                "title": "Search error",
                "url": "",
                "description": str(e),
            }
        ]
    finally:
        client.close()

    soup = BeautifulSoup(resp.text, "html.parser")
    results: List[Dict[str, str]] = []

    for result in soup.select(".result"):
        if len(results) >= limit:
            break

        a = result.select_one(".result__title a")
        snippet_el = result.select_one(".result__snippet")

        if not a:
            continue

        title = (a.get_text() or "").strip()
        url = (a.get("href") or "").strip()
        description = (snippet_el.get_text() if snippet_el else "").strip()

        if title and url:
            results.append(
                {
                    "title": title,
                    "url": url,
                    "description": description,
                }
            )

    return results


# --- HTTP fetch helper --------------------------------------------------------------


def http_fetch(
    url: str,
    max_bytes: int = 200_000,
    timeout_ms: int = 15_000,
    follow_redirects: bool = True,
) -> Dict[str, Any]:
    """
    Fetch a URL with basic size limiting and content-type handling.
    """
    timeout = timeout_ms / 1000.0
    client = _create_http_client()

    try:
        resp = client.get(
            url,
            timeout=timeout,
            follow_redirects=follow_redirects,
        )
    except Exception as e:  # noqa: BLE001
        return {
            "url": url,
            "final_url": url,
            "status": 0,
            "content_type": None,
            "encoding": None,
            "headers": {},
            "body": str(e),
            "truncated": False,
        }
    finally:
        client.close()

    content_type = resp.headers.get("content-type")
    encoding: Optional[str] = None

    if content_type:
        # e.g. "text/html; charset=utf-8"
        parts = content_type.split(";")
        for p in parts[1:]:
            p = p.strip()
            if p.lower().startswith("charset="):
                encoding = p.split("=", 1)[1].strip().lower()
                break

    raw_bytes = resp.content
    truncated = False
    if len(raw_bytes) > max_bytes:
        raw_bytes = raw_bytes[:max_bytes]
        truncated = True

    ct_lower = (content_type or "").lower()
    is_binary = (
        ct_lower.startswith("image/")
        or ct_lower.startswith("audio/")
        or ct_lower.startswith("video/")
        or ct_lower.startswith("application/pdf")
        or ct_lower.startswith("application/zip")
        or ct_lower.startswith("application/x-")
        or ct_lower == "application/octet-stream"
    )

    if is_binary:
        body = "Unsupported content-type"
    else:
        charset = encoding or "utf-8"
        try:
            body = raw_bytes.decode(charset, errors="replace")
        except Exception:  # noqa: BLE001
            body = raw_bytes.decode("utf-8", errors="replace")
            if not encoding:
                encoding = "utf-8"

    final_url = str(resp.url)

    # Convert httpx headers to a JSON-friendly dict
    headers: Dict[str, Any] = dict(resp.headers)

    return {
        "url": url,
        "final_url": final_url,
        "status": resp.status_code,
        "content_type": content_type,
        "encoding": encoding,
        "headers": headers,
        "body": body,
        "truncated": truncated,
    }


# --- MCP server (FastMCP, SSE) ------------------------------------------------------


# FastMCP instance. The server name is what MCP clients (e.g., LibreChat) will see.
mcp = FastMCP("python-web-search")


@mcp.tool()
def search(query: str, limit: Optional[int] = None) -> Dict[str, Any]:
    """
    Perform a web search using DuckDuckGo's HTML interface.

    This tool is intended for MCP clients that need to look up information on the
    public web without any API keys. It returns a small list of matching pages
    with titles, URLs, and short snippets. Typical usage is to call this tool
    first to discover relevant pages, then use the "fetch" tool to read
    a specific URL in more detail.

    Parameters
    ----------
    query:
        Search query in natural language or keywords.
    limit:
        Optional maximum number of results to return. If omitted or invalid,
        a default of 5 is used.

    Returns
    -------
    Dict[str, Any]:
        A dictionary with a single key "results". The value is a list of
        result objects:
          - title: Page title.
          - url: Resolved HTTP(S) URL.
          - description: Short snippet from the search result (may be empty).

    Notes
    -----
    - This tool does not fetch full page content; use "fetch" for that.
    - When presenting results in a browser or graphical UI, it is recommended
      to show at least the title and URL for each result (and optionally the
      description/snippet) so that users can clearly see what pages will be
      opened.
    - Results are scraped from DuckDuckGo HTML and may be incomplete or
      occasionally missing snippets.
    - The ranking and freshness are controlled by DuckDuckGo and are
      best-effort only.
    """
    effective_limit = limit if isinstance(limit, int) and limit > 0 else 5
    results = duckduckgo_search(query=query, limit=effective_limit)
    return {"results": results}


@mcp.tool()
def fetch(
    url: str,
    max_bytes: Optional[int] = None,
    timeout_ms: Optional[int] = None,
    follow_redirects: Optional[bool] = None,
) -> Dict[str, Any]:
    """
    Fetch the contents of a single HTTP(S) URL.

    This tool is intended for MCP clients that need to retrieve the body,
    status code, headers, and final URL after redirects for a given resource.
    A common pattern is to call the "search" tool to discover candidate
    URLs, then use this tool to read one of those URLs in detail.

    Parameters
    ----------
    url:
        Target HTTP(S) URL to fetch.
    max_bytes:
        Optional hard limit on the number of response bytes to read. Defaults
        to 200_000 bytes. Responses larger than this limit are truncated and
        reported via the "truncated" flag.
    timeout_ms:
        Optional request timeout in milliseconds. Defaults to 15_000 ms.
    follow_redirects:
        Whether to follow HTTP redirects. Defaults to True.

    Returns
    -------
    Dict[str, Any]:
        A dictionary with keys:
          - url: The original URL requested.
          - final_url: The final URL after redirects (if any).
          - status: HTTP status code (0 on network errors).
          - content_type: Raw Content-Type header value, if present.
          - encoding: Detected character encoding for text responses.
          - headers: Response headers as a dictionary.
          - body: Response body as text, or an error/placeholder message for
            unsupported binary content-types.
          - truncated: True if the response body was cut off due to max_bytes.

    Notes
    -----
    - Binary content (images, most application/* types, etc.) is not returned
      as raw bytes; instead, a placeholder string is used in "body".
    - When presenting fetched content in a browser or graphical UI, it is
      recommended to clearly display at least the final_url (and optionally
      the HTTP status and content_type) so that users can see which site is
      being accessed before opening or rendering the page body.
    - Outbound requests honour standard HTTP(S)_PROXY and NO_PROXY environment
      variables via the underlying HTTPX client.
    """
    effective_max_bytes = max_bytes if isinstance(max_bytes, int) and max_bytes > 0 else 200_000
    effective_timeout_ms = timeout_ms if isinstance(timeout_ms, int) and timeout_ms > 0 else 15_000
    effective_follow_redirects = bool(follow_redirects) if follow_redirects is not None else True

    return http_fetch(
        url=url,
        max_bytes=effective_max_bytes,
        timeout_ms=effective_timeout_ms,
        follow_redirects=effective_follow_redirects,
    )


# FastMCP builds an ASGI app that exposes an SSE MCP server.
# By default, it exposes `/sse` and `/messages` endpoints.
app = mcp.sse_app()


def main() -> None:
    """
    Entry point for starting the SSE MCP server with uvicorn.

    - Port is taken from the PORT environment variable (default: 8000)
    - Host is 0.0.0.0
    """
    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run(app, host="0.0.0.0", port=port)


if __name__ == "__main__":
    main()