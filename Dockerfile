# Python-based SSE MCP server for web search.
# Uses uv (locally) for dependency management via pyproject.toml, but
# inside the container we just use a standard python:3.12 image and pip.

FROM python:3.12-slim

WORKDIR /app

# Install system dependencies (if needed for httpx / SSL / DNS etc.)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Copy project metadata first (for layer caching)
COPY pyproject.toml ./pyproject.toml

# Install runtime dependencies via pip based on pyproject.toml
# 簡易的に直接必要パッケージをインストールする（uv はローカル開発側で使用）
RUN pip install --no-cache-dir \
    mcp \
    anyio \
    httpx \
    beautifulsoup4 \
    uvicorn

# Copy the actual source code
COPY mcp_server.py ./mcp_server.py

# Default environment
ENV PYTHONUNBUFFERED=1
ENV PORT=8000

# Expose uvicorn port
EXPOSE 8000

# Run the SSE MCP server
# FastMCP の mcp.sse_app() が /sse と /messages を公開する
CMD ["python", "mcp_server.py"]