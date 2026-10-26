# ikea-mcp

An MCP server to plan your IKEA shopping with Claude: catalog search, product details
(dimensions, number of packages, weight, longest package), stores and opening hours,
a persistent shopping list with totals, and an ikea.com guest cart.

> **Unofficial.** This project is not affiliated with or endorsed by IKEA. IKEA has no
> public API: the server uses the same undocumented endpoints as the ikea.com website,
> which can change or break without notice. Use it for personal shopping only.

Runs on [Bun](https://bun.sh) ≥ 1.4.4.

## Tools

| Tool                                                                 | What it does                                                                   |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `search_products`                                                    | Catalog search, with an optional max price                                     |
| `get_product`                                                        | Details of an item or a combination                                            |
| `list_stores`                                                        | Stores, addresses, opening hours, upcoming closures                            |
| `shopping_list_view`                                                 | Shopping list + totals (price, packages, weight), optional price re-check      |
| `shopping_list_add` / `shopping_list_remove` / `shopping_list_clear` | Manage the list                                                                |
| `cart_view`                                                          | IKEA cart with prices incl. VAT, eco fee, packages and weight computed by IKEA |
| `cart_add` / `cart_add_shopping_list`                                | Add items, or the whole shopping list                                          |
| `cart_set_quantity` / `cart_remove` / `cart_clear`                   | Manage the cart                                                                |

The shopping list is saved in `~/.ikea-mcp/shopping-list.json`.

### Guest cart

The cart uses ikea.com's internal cart API with a **guest** token (like a visitor who is
not signed in). The token is valid for 30 days and kept in `~/.ikea-mcp/cart.json`
(readable by you only). As a result:

- it is a real IKEA cart, with IKEA's prices and checks (invalid items or items not sold
  online are rejected);
- it is **separate from the cart of your IKEA account**: it does not show up when you
  sign in on ikea.com, and checkout cannot happen from the MCP;
- when the token expires, a new empty cart is created.

## Installation

Straight from GitHub with `bunx`, nothing to clone: Bun fetches the repository and its
dependencies into its cache on first launch.

### Claude Code

```bash
claude mcp add ikea -- bunx -p github:lgrosjean/ikea-mcp ikea-mcp
```

### Claude Desktop

In Settings → Developer → Edit Config (`~/Library/Application Support/Claude/claude_desktop_config.json`),
add an `ikea` entry under `mcpServers`, then quit (⌘Q) and reopen Claude Desktop. Use the absolute
path to `bunx`: Claude Desktop does not see `~/.bun/bin` in its `PATH`.

```json
{
  "mcpServers": {
    "ikea": {
      "command": "/Users/YOU/.bun/bin/bunx",
      "args": ["-p", "github:lgrosjean/ikea-mcp", "ikea-mcp"]
    }
  }
}
```

### From source

```bash
git clone https://github.com/lgrosjean/ikea-mcp.git && cd ikea-mcp
bun install
bun run build        # builds the standalone executable dist/ikea-mcp
claude mcp add ikea -- "$PWD/dist/ikea-mcp"
```

### HTTP (Bun.serve)

```bash
bun run serve                      # http://127.0.0.1:3000/mcp
claude mcp add --transport http ikea http://127.0.0.1:3000/mcp
```

By default the server only listens on 127.0.0.1 (use `--host` / `--port` to change it)
and rejects requests whose Host header is not local.

## Configuration

| Variable                     | Default                          | Purpose                                                    |
| ---------------------------- | -------------------------------- | ---------------------------------------------------------- |
| `IKEA_COUNTRY` / `IKEA_LANG` | `fr` / `fr`                      | IKEA website to use (e.g. `gb`/`en`, `us`/`en`, `de`/`de`) |
| `IKEA_LIST_FILE`             | `~/.ikea-mcp/shopping-list.json` | Shopping list file                                         |
| `IKEA_CART_FILE`             | `~/.ikea-mcp/cart.json`          | Guest cart token                                           |
| `PORT`                       | `3000`                           | HTTP mode port                                             |

## Development

```bash
bun test             # end-to-end tests (stdio + HTTP) against the real IKEA website
bun check            # type check (Bun's built-in checker, no tsc needed)
bun fmt              # format (Bun's built-in formatter, config in bunfig.toml)
```
