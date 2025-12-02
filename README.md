# Web Search MCP Server (Python + SSE)

This repository provides a **Model Context Protocol (MCP)** server that lets LLM clients perform web searches
using DuckDuckGo HTML results and fetch arbitrary HTTP(S) URLs. It is implemented in Python using the
[`mcp` Python SDK](https://github.com/modelcontextprotocol/python-sdk) and exposes an **SSE MCP endpoint**
suitable for clients like LibreChat.

## Features

- Web search via DuckDuckGo HTML (no API keys required)
- Simple HTTP(S) fetch tool that returns status, headers, and body
- Implemented with Python 3.12, FastMCP, and uvicorn
- Exposes an SSE endpoint (`/sse`) for MCP clients
- Supports outbound HTTP(S) proxy settings via standard environment variables

## Repository layout

Main files:

- [`mcp_server.py`](mcp_server.py:1) – Python FastMCP server implementation (tools and SSE app)
- [`pyproject.toml`](pyproject.toml:1) – project metadata and Python dependencies
- [`Dockerfile`](Dockerfile:1) – container image for the MCP server
- [`docker-compose.yml`](docker-compose.yml:1) – example service definition for running the server as a sidecar

## MCP tools

The server exposes two MCP tools: `search` and `fetch`.

### `search`

Parameters:

```jsonc
{ "query": "string",   // Required: search query
  "limit": 5           // Optional: max results (default: 5, max: 10)
}
```

Response shape:

```json
[
  { "title": "Example result",
    "url": "https://example.com",
    "description": "Snippet from the search result"
  }
]
```

### `fetch`

Parameters:

```jsonc
{ "url": "https://example.com",   // Required
  "max_bytes": 200000,            // Optional: max bytes to read (default: 200000)
  "timeout_ms": 15000,            // Optional: timeout in ms (default: 15000)
  "follow_redirects": true        // Optional: follow redirects (default: true)
}
```

Response shape (simplified):

```json
{
  "url": "https://example.com",
  "final_url": "https://www.example.com/",
  "status": 200,
  "content_type": "text/html; charset=UTF-8",
  "encoding": "utf-8",
  "headers": { "content-type": "text/html; charset=UTF-8" },
  "body": "<!doctype html>...",
  "truncated": false
}
```

## Running locally (Python)

This project is now **Python-only**. The previous Node.js / TypeScript implementation has been removed.

You can manage dependencies with [uv](https://github.com/astral-sh/uv) or plain pip.

### Install dependencies with uv

```bash
# from the repository root (where pyproject.toml lives)
uv sync --no-dev
```

### Run the MCP server with uv

```bash
uv run python mcp_server.py
```

By default, the server listens on port `8000` and exposes:

- SSE endpoint: `GET /sse`
- Message endpoint: `POST /messages/?session_id=...`

You can override the port with the `PORT` environment variable:

```bash
PORT=9000 uv run python mcp_server.py
```

## Docker

You can build and run the MCP server as a Docker container using the root-level
[`Dockerfile`](Dockerfile:1).

### Build image

```bash
docker build -t web-search-mcp .
```

### Run container directly (for testing)

```bash
docker run --rm -p 9999:8000 web-search-mcp
# SSE endpoint will be available at http://localhost:9999/sse
```

## Docker Compose

The repository includes a [`docker-compose.yml`](docker-compose.yml:1) for running the server as a long-lived service:

```yaml
version: "3.9"

services:
  web-search-mcp:
    build: .
    container_name: web-search-mcp
    environment:
      - PORT=8000
      # - HTTP_PROXY=
      # - HTTPS_PROXY=
      # - NO_PROXY=
    ports:
      - "9999:8000"
    restart: unless-stopped
```

Start the service:

```bash
docker compose up -d web-search-mcp
```

Then the SSE endpoint is available on the host at:

- `http://localhost:9999/sse`

## MCP client configuration

### Generic SSE MCP configuration (Claude Desktop / VSCode etc.)

Example (pseudo-config) for an MCP client that supports SSE servers:

```jsonc
{
  "mcpServers": {
    "web-search": {
      "type": "sse",
      "url": "http://localhost:9999/sse"
    }
  }
}
```

### LibreChat

LibreChat supports MCP servers via SSE (and streamable HTTP). With the Docker Compose setup above,
the web-search MCP server is reachable from the LibreChat container at `http://web-search-mcp:8000/sse`
or from the host at `http://localhost:9999/sse`.

A typical `librechat.yaml` snippet looks like:

```yaml
mcpServers:
  web-search:
    type: sse
    # If LibreChat runs on the host: use host.docker.internal:9999
    url: http://host.docker.internal:9999/sse
    timeout: 60000
    chatMenu: true
    serverInstructions: true
```

Adjust the `url` depending on your deployment:

- Docker Compose same-network access: `http://web-search-mcp:8000/sse`
- Host-mapped port access (as in this repo): `http://host.docker.internal:9999/sse`

## Proxy support

Outbound HTTP(S) requests (DuckDuckGo search and HTTP fetch) respect standard proxy environment variables:

- `HTTPS_PROXY` / `https_proxy`
- `HTTP_PROXY` / `http_proxy`
- `NO_PROXY` / `no_proxy`

To use a corporate proxy, set these on the host or in your Docker Compose service:

```yaml
services:
  web-search-mcp:
    environment:
      - PORT=8000
      - HTTP_PROXY=http://proxy.example.com:8080
      - HTTPS_PROXY=http://proxy.example.com:8080
      - NO_PROXY=localhost,127.0.0.1
```

## Example usage from an MCP client

In a generic MCP client that exposes a `use_mcp_tool`-style interface, you can call the tools like this:

```typescript
// search
await use_mcp_tool({
  server_name: "web-search",
  tool_name: "search",
  arguments: { query: "your search query", limit: 3 }
});

// fetch
await use_mcp_tool({
  server_name: "web-search",
  tool_name: "fetch",
  arguments: { url: "https://example.com" }
});
```

## Limitations

- Web search is implemented via HTML scraping of DuckDuckGo.
- Be mindful of DuckDuckGo's terms of service and robots.txt.
- This server is intended for personal / experimental use; for production use, consider a proper search API.

## Contributing

Issues and enhancement requests are welcome. This project is intentionally small so it can serve as
a reference for building Python-based SSE MCP servers that can be wired into tools like LibreChat.
