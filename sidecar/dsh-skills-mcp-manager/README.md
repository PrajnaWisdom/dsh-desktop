# @dsh-desktop/dsh-skills-mcp-manager

First-party Skills & MCP manager for the dsh desktop web GUI, functionally
equivalent to the third-party `@zebbkira/dsh-skills-mcp-manager` but fully
theme-aware: every color is driven by the shell's `--dsw-*` design tokens, so it
follows the 「外观」 setting (亮色 / 暗色 / 跟随系统).

## Features

- **Skills** — browse, enable/disable, delete and import skills from the project
  (`.dsh/skills`, `.agents/skills`) and user (`~/.dsh/skills`, `~/.agents/skills`)
  roots. Import copies into `~/.dsh/skills`.
- **MCP** — list/add/edit/delete MCP servers (`stdio` and `streamable-http`),
  enable/disable them, and test the connection. Enabled servers connect for real
  through `@deepseek-ai/dsh-mcp-client` and register tools as
  `mcp__<server>__<tool>`.

## Layout

| Path               | Purpose                                                        |
| ------------------ | -------------------------------------------------------------- |
| `lib/index.js`     | Host half: skills engine, MCP manager, `/api/skills-mcp` routes |
| `lib/client.js`    | Browser half: theme-aware settings section UI                  |
| `cordis.patch.yml` | Bundle patch that inserts the plugin row                       |

## API

All routes are loopback-only and JSON (`application/json; charset=utf-8`):

- `GET  /api/skills-mcp/skills?cwd=<path>`
- `POST /api/skills-mcp/skills/read`      `{ path }`
- `POST /api/skills-mcp/skills/toggle`    `{ path, enabled }`
- `POST /api/skills-mcp/skills/delete`    `{ path, kind }`
- `POST /api/skills-mcp/skills/scan`      `{ dir }`
- `POST /api/skills-mcp/skills/import`    `{ items: [{ sourcePath, kind }] }`
- `GET  /api/skills-mcp/mcp`
- `POST /api/skills-mcp/mcp/save`         `{ server }`
- `POST /api/skills-mcp/mcp/enabled`      `{ name, enabled }`
- `POST /api/skills-mcp/mcp/delete`       `{ name }`
- `POST /api/skills-mcp/mcp/test`         `{ server }`

## Theme tokens used

`--dsw-alias-bg-base`, `--dsw-alias-bg-layer-1`, `--dsw-alias-bg-overlay`,
`--dsw-alias-border-l2/l3/l4`, `--dsw-alias-label-primary/secondary/tertiary`,
`--dsw-alias-interactive-bg-hover/active`, `--dsw-alias-button-primary-fill/hover`,
`--dsw-alias-label-primary-inverted`, `--dsw-alias-state-error-primary/secondary`,
`--dsw-alias-state-success-primary`, `--dsw-alias-brand-primary`.
