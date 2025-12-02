#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import axios, { AxiosInstance } from 'axios';
import * as cheerio from 'cheerio';
import { HttpsProxyAgent } from 'https-proxy-agent';

interface SearchResult {
  title: string;
  url: string;
  description: string;
}

/**
 * Create an Axios HTTP client that optionally uses an HTTP(S) proxy.
 *
 * Proxy configuration is taken from standard environment variables:
 *   - HTTPS_PROXY / https_proxy
 *   - HTTP_PROXY / http_proxy
 *   - NO_PROXY / no_proxy (handled by the proxy itself, not here)
 *
 * If no proxy variable is set or the value is invalid, a default Axios
 * instance without explicit proxy configuration is returned.
 */
const createHttpClient = (): AxiosInstance => {
  const proxyEnv =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy;

  // No proxy defined: use default Axios instance (it may still honor NO_PROXY).
  if (!proxyEnv) {
    return axios;
  }

  try {
    // Use https-proxy-agent so that HTTPS requests go through CONNECT,
    // similar to how curl behaves with HTTPS_PROXY/HTTP_PROXY.
    const agent = new HttpsProxyAgent(proxyEnv);

    return axios.create({
      // Disable Axios' built-in proxy handling in favor of a custom agent.
      proxy: false,
      httpsAgent: agent,
    });
  } catch (error) {
    console.error(
      'Invalid proxy configuration in HTTPS_PROXY/HTTP_PROXY:',
      error
    );
    return axios;
  }
};

// Shared HTTP client used for all outbound requests
const httpClient = createHttpClient();

const isValidSearchArgs = (args: any): args is { query: string; limit?: number } =>
  typeof args === 'object' &&
  args !== null &&
  typeof args.query === 'string' &&
  (args.limit === undefined || typeof args.limit === 'number');

class WebSearchServer {
  private server: Server;

  constructor() {
    this.server = new Server(
      {
        name: 'web-search',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();
    
    this.server.onerror = (error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'search',
          description: 'Search the web using DuckDuckGo (no API key required)',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Search query',
              },
              limit: {
                type: 'number',
                description: 'Maximum number of results to return (default: 5)',
                minimum: 1,
                maximum: 10,
              },
            },
            required: ['query'],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name !== 'search') {
        throw new McpError(
          ErrorCode.MethodNotFound,
          `Unknown tool: ${request.params.name}`
        );
      }

      if (!isValidSearchArgs(request.params.arguments)) {
        throw new McpError(
          ErrorCode.InvalidParams,
          'Invalid search arguments'
        );
      }

      const query = request.params.arguments.query;
      const limit = Math.min(request.params.arguments.limit || 5, 10);

      try {
        const results = await this.performSearch(query, limit);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(results, null, 2),
            },
          ],
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : JSON.stringify(error);
        return {
          content: [
            {
              type: 'text',
              text: `Search error: ${message}`,
            },
          ],
          isError: true,
        };
      }
    });
  }

  private async performSearch(query: string, limit: number): Promise<SearchResult[]> {
    // Scrape DuckDuckGo HTML search results via HTTP (no Selenium dependency)
    try {
      const response = await httpClient.get('https://html.duckduckgo.com/html/', {
        params: {
          q: query,
          s: '0',
        },
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          // Force plain response over proxy to avoid Squid ERR_READ_ERROR on compressed payloads
          'Accept-Encoding': 'identity',
          Referer: 'https://duckduckgo.com/',
        },
        timeout: 15000,
      });

      const $ = cheerio.load(response.data);
      const results: SearchResult[] = [];

      $('.result').each((i, el) => {
        if (results.length >= limit) {
          return false; // stop iteration
        }
        const $el = $(el);
        const title = $el.find('.result__title a').text().trim();
        const url = $el.find('.result__title a').attr('href') || '';
        const description = $el.find('.result__snippet').text().trim();

        if (title && url) {
          results.push({ title, url, description });
        }
        return undefined;
      });

      return results;
    } catch (error) {
      console.error('DuckDuckGo search error:', error);
      return [
        {
          title: 'Search error',
          url: '',
          description: error instanceof Error ? error.message : 'Unknown error',
        },
      ];
    }
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Web Search MCP server running on stdio');
  }
}

const server = new WebSearchServer();
server.run().catch(console.error);
