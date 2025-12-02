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
import { TextDecoder } from 'node:util';

interface SearchResult {
  title: string;
  url: string;
  description: string;
}

interface FetchResult {
  url: string;
  final_url: string;
  status: number;
  content_type: string | null;
  encoding: string | null;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  truncated: boolean;
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

const isValidFetchArgs = (args: any): args is {
  url: string;
  max_bytes?: number;
  timeout_ms?: number;
  follow_redirects?: boolean;
} =>
  typeof args === 'object' &&
  args !== null &&
  typeof args.url === 'string' &&
  (args.max_bytes === undefined || typeof args.max_bytes === 'number') &&
  (args.timeout_ms === undefined || typeof args.timeout_ms === 'number') &&
  (args.follow_redirects === undefined || typeof args.follow_redirects === 'boolean');

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
        {
          name: 'fetch',
          description: 'Fetch the contents of a URL over HTTP(S)',
          inputSchema: {
            type: 'object',
            properties: {
              url: {
                type: 'string',
                description: 'URL to fetch',
              },
              max_bytes: {
                type: 'number',
                description:
                  'Maximum number of bytes to fetch (default: 200000)',
              },
              timeout_ms: {
                type: 'number',
                description:
                  'Request timeout in milliseconds (default: 15000)',
              },
              follow_redirects: {
                type: 'boolean',
                description:
                  'Whether to follow HTTP redirects (default: true)',
              },
            },
            required: ['url'],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const toolName = request.params.name;

      if (toolName === 'search') {
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
      }

      if (toolName === 'fetch') {
        if (!isValidFetchArgs(request.params.arguments)) {
          throw new McpError(
            ErrorCode.InvalidParams,
            'Invalid fetch arguments'
          );
        }

        const result = await this.fetchUrl(request.params.arguments);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      throw new McpError(
        ErrorCode.MethodNotFound,
        `Unknown tool: ${request.params.name}`
      );
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

  private async fetchUrl(args: {
    url: string;
    max_bytes?: number;
    timeout_ms?: number;
    follow_redirects?: boolean;
  }): Promise<FetchResult> {
    const {
      url,
      max_bytes = 200000,
      timeout_ms = 15000,
      follow_redirects = true,
    } = args;

    const maxBytes =
      typeof max_bytes === 'number' && max_bytes > 0 ? max_bytes : 200000;

    try {
      const response = await httpClient.get(url, {
        responseType: 'arraybuffer',
        timeout: timeout_ms,
        maxRedirects: follow_redirects ? 5 : 0,
        // We want to capture even non-2xx responses
        validateStatus: () => true,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: '*/*',
        },
      });

      const rawContentType = response.headers['content-type'];
      const contentType = Array.isArray(rawContentType)
        ? rawContentType[0]
        : rawContentType || null;

      let encoding: string | null = null;
      if (contentType && typeof contentType === 'string') {
        const match = contentType.match(/charset=([^;]+)/i);
        if (match) {
          encoding = match[1].trim().toLowerCase();
        }
      }

      const buffer = Buffer.from(response.data as ArrayBufferLike);
      let truncated = false;
      let limitedBuffer = buffer;

      if (buffer.byteLength > maxBytes) {
        limitedBuffer = buffer.subarray(0, maxBytes);
        truncated = true;
      }

      const ct = contentType ? contentType.toLowerCase() : '';
      const isBinary =
        /^image\//.test(ct) ||
        /^audio\//.test(ct) ||
        /^video\//.test(ct) ||
        /^application\/(pdf|zip|x-)/.test(ct) ||
        ct === 'application/octet-stream';

      let body = '';

      if (isBinary) {
        body = 'Unsupported content-type';
      } else {
        const charset = encoding || 'utf-8';
        try {
          const decoder = new TextDecoder(charset);
          body = decoder.decode(limitedBuffer);
        } catch {
          const fallbackDecoder = new TextDecoder('utf-8');
          body = fallbackDecoder.decode(limitedBuffer);
          if (!encoding) {
            encoding = 'utf-8';
          }
        }
      }

      let finalUrl = url;
      const anyRequest = response.request as any;
      if (anyRequest?.res?.responseUrl) {
        finalUrl = anyRequest.res.responseUrl;
      } else if (response.config?.url) {
        finalUrl = response.config.url;
      }

      const fetchResult: FetchResult = {
        url,
        final_url: finalUrl,
        status: response.status,
        content_type: contentType,
        encoding,
        headers: response.headers as Record<string, string | string[] | undefined>,
        body,
        truncated,
      };

      return fetchResult;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : JSON.stringify(error);
      const fetchResult: FetchResult = {
        url: args.url,
        final_url: args.url,
        status: 0,
        content_type: null,
        encoding: null,
        headers: {},
        body: message,
        truncated: false,
      };
      return fetchResult;
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
