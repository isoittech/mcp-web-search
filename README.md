# Web Search MCP Server

A Model Context Protocol (MCP) server that enables free web searching using DuckDuckGo search results, with no API keys required.

## Features

- Search the web using DuckDuckGo search results
- No API keys or authentication required
- Returns structured results with titles, URLs, and descriptions
- Configurable number of results per search

## Installation

1. Clone or download this repository
2. Install dependencies:
```bash
npm install
```
3. Build the server:
```bash
npm run build
```
4. Add the server to your MCP configuration:

For VSCode (Claude Dev Extension):
```json
{
  "mcpServers": {
    "web-search": {
      "command": "node",
      "args": ["/path/to/web-search/build/index.js"]
    }
  }
}
```

For Claude Desktop:
```json
{
  "mcpServers": {
    "web-search": {
      "command": "node",
      "args": ["/path/to/web-search/build/index.js"]
    }
  }
}
```

## Docker

You can also run this MCP server inside a Docker container.

### Build image

```bash
docker build -t <something>/web-search-mcp .
```

### Run locally for testing

This will start the MCP server on stdio inside the container:

```bash
docker run --rm -i <something>/web-search-mcp
```

### Use from MCP clients via Docker

For VSCode (Claude Dev Extension):

```jsonc
{
  "mcpServers": {
    "web-search": {
      "command": "docker",
      "args": [
        "run",
        "--rm",
        "-i",
        // Forward proxy settings from the host environment into the container
        "-e",
        "HTTP_PROXY",
        "-e",
        "HTTPS_PROXY",
        "<something>/web-search-mcp"
      ]
    }
  }
}
```

For Claude Desktop:

```jsonc
{
  "mcpServers": {
    "web-search": {
      "command": "docker",
      "args": [
        "run",
        "--rm",
        "-i",
        // Forward proxy settings from the host environment into the container
        "-e",
        "HTTP_PROXY",
        "-e",
        "HTTPS_PROXY",
        "<something>/web-search-mcp"
      ]
    }
  }
}
```

## Proxy support

This server supports outbound HTTP(S) requests via a corporate proxy.

Proxy configuration is taken from standard environment variables:

- `HTTPS_PROXY` / `https_proxy`
- `HTTP_PROXY` / `http_proxy`
- `NO_PROXY` / `no_proxy` (domains that should not be proxied; handled by the HTTP stack / proxy agent)

If `HTTPS_PROXY` or `HTTP_PROXY` is set, the server will route all DuckDuckGo requests through that proxy using a CONNECT tunnel (via [`https-proxy-agent`](package.json:19)).

### Example: local Node execution with proxy

```bash
export HTTPS_PROXY=http://pxoy-server
export HTTP_PROXY=http://pxoy-server
# NO_PROXY can be set as needed, e.g.:
# export NO_PROXY=localhost,127.0.0.1

node build/index.js
```

### Example: Docker with proxy

```bash
docker run --rm -i \
  -e HTTPS_PROXY=http://pxoy-server \
  -e HTTP_PROXY=http://pxoy-server \
  <something>/web-search-mcp
```

In MCP client configurations (VSCode, Claude Desktop, etc.), you can forward the proxy variables from the host shell into the container by passing `-e HTTP_PROXY` / `-e HTTPS_PROXY` in the `args` array.

## Usage

The server provides a single tool named `search` that accepts the following parameters:

```typescript
{
  "query": string,    // The search query
  "limit": number     // Optional: Number of results to return (default: 5, max: 10)
}
```

Example usage:
```typescript
use_mcp_tool({
  server_name: "web-search",
  tool_name: "search",
  arguments: {
    query: "your search query",
    limit: 3  // optional
  }
})
```

Example response:
```json
[
  {
    "title": "Example Search Result",
    "url": "https://example.com",
    "description": "Description of the search result..."
  }
]
```

## Limitations

Since this tool uses web scraping of DuckDuckGo search results, there are some important limitations to be aware of:

3. **Legal Considerations**:
   - This tool is intended for personal use
   - Respect DuckDuckGo's terms of service and robots.txt

## Contributing

Feel free to submit issues and enhancement requests!
