# Ultimath MCP

**Stop hallucinating numbers.** An MCP server that runs every math expression
through four independent numeric engines in parallel and returns all four
results side by side — so when they disagree, you know the answer is
numerically unreliable.

The four engines:

| Engine            | What it does                                      |
| ----------------- | ------------------------------------------------- |
| Multiprecision    | High-precision arbitrary-digit arithmetic         |
| Exact decimal     | Exact base-10 arithmetic                          |
| IEEE-754 double   | Standard hardware floating point                  |
| Interval          | Rigorous lower/upper bounds (guaranteed enclosure)|

## Tools

- **`evaluate`** — evaluate an expression on all four engines and compare.
  Supports arithmetic, trig (`sin`, `cos`, `tan`), exp/log (`exp`, `ln`, `log`),
  roots and powers (`sqrt`, `x^y`), factorial, complex numbers (`3+2i`),
  alternate bases (`0xFF`, `0b1010`), and constants (`pi`, `e`, golden ratio `PHI`).
- **`list_functions`** — list every function the engines expose
  (name, arity, category, description). Optionally filter by category.

> Multiplication must be **explicit**: write `2*pi`, `2*sin(x)`, `(a+b)*(c+d)`.
> Adjacency is not a product (`2pi` is an error). Expressions are purely
> mathematical — no type casts or constructors; write a complex number as
> `1+2i`.

## Setup

1. Get a free API key at **https://ultimath.ai**.
2. Add the server to your MCP client config (example for Claude Desktop):

```json
{
  "mcpServers": {
    "ultimath": {
      "command": "npx",
      "args": ["-y", "ultimath-mcp"],
      "env": {
        "ULTIMATH_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

That's it — `npx` fetches and runs the server on demand.

## Requirements

- Node.js ≥ 18
- An Ultimath API key (`ULTIMATH_API_KEY`)

## Links

- Website: https://ultimath.ai
- Source: https://github.com/Flupke68/ultimath-mcp

## Under the hood

Ultimath's engines build on FLINT/Arb, GMP/MPFR and Boost — full credits at
https://ultimath.ai/credits.

## Privacy

Ultimath stores only a hash of your API key and basic usage metrics to run and
secure the service; expressions are evaluated, not retained for training. Full
policy: https://ultimath.ai/privacy/

## License

MIT
