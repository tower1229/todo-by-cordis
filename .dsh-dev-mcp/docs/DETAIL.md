# 开发常用 MCP 套件 (`@local/dev-mcp`)

本纯配置 Bundle 为当前 DSH profile 接入以下官方 MCP 服务器：

- **GitHub** (`github`): `https://api.githubcopilot.com/mcp/`，自动复用环境变量或本机 `gh auth token`。
- **Context7** (`context7`): `https://mcp.context7.com/mcp`，自动复用 `~/.cursor/mcp.json` 中的 `CONTEXT7_API_KEY`。
- **Cloudflare Docs** (`cf_docs`): `https://docs.mcp.cloudflare.com/mcp`（免鉴权）。
- **Cloudflare Workers Bindings** (`cf_bindings`): 通过 `mcp-remote` 走浏览器 OAuth 接入 `https://bindings.mcp.cloudflare.com/mcp`。
- **Cloudflare Observability** (`cf_observability`): 通过 `mcp-remote` 走浏览器 OAuth 接入 `https://observability.mcp.cloudflare.com/mcp`。
