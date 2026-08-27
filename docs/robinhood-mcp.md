# Robinhood Agentic Trading — reference (what the MCP gives us)

Sources: Robinhood "Agentic Trading overview", "Trading with your agent",
"Robinhood is now open to agents" (newsroom). Read 2026-06-20.

## Connection
- **MCP endpoint:** `https://agent.robinhood.com/mcp/trading` (Streamable HTTP, OAuth).
- Claude Code: `claude mcp add robinhood-trading --transport http https://agent.robinhood.com/mcp/trading` then `/mcp` → authorize.
- Onboarding requires a **desktop browser**; creates a **Robinhood Agentic account**.
- Requires a primary individual investing account in good standing; max 10 self-directed individual accounts.

## The Agentic account (our "bot account")
- **Separate, isolated account.** Agents can place orders **only** here; every other account is **read-only**.
- **Starts unfunded** — the user moves money in deliberately. The agent can only use deposited funds.
- Orders show up in the Robinhood Activity feed + history; push notifications fire on every agent trade.
- The agent can be **disconnected at any time** from the Robinhood app.

## What the agent can READ
- All account numbers, positions, balances, buying power, portfolio value.
- Transaction history and order history.
- Market data (for analysis/research).

## What the agent can DO (actions)
- Place **long equities and options orders** (long only — **no short selling**).
- Build portfolios from research, automate strategies (conditional orders), rebalance, analyze risk.
- **~21 MCP tools** total — exact names + input schemas come from `listTools()` after auth.

## Asset support (as of 2026-06)
- ✅ **Equities / ETFs** (live).
- ✅ **Options** (long options; rolling out).
- ❌ **Crypto** — NOT available for agents yet ("coming soon") **and permanently blocked in this app by policy**.
- ❌ Futures, event contracts, prediction markets — not yet.

## Order constraints (Robinhood platform)
- Order types: **market** (Good-for-Day), **limit / stop / stop-limit** (GFD or GTC).
- **No short selling**, **no bracket orders**, **no market-on-open/close** → the app manages exits itself rather than relying on broker-side brackets.
- Long only: a `sell` closes an existing long; sell qty must not exceed held qty.

## Execution / safety model (maps to our modes)
- The agent can **preview** every order before acting (→ our `cautious` mode = one-click approve).
- If pre-authorized, it can **execute without per-trade confirmation** (→ our `auto` / `full_auto`).
- Robinhood-side guardrails: dedicated isolated account, deliberate funding, activity monitoring, optional manual approval.

## How THIS app uses it
- Backend is an MCP **client** (OAuth tokens persisted locally) → headless bots can run.
- Every order intent flows through `executeDraft()` → deterministic risk engine → mode decision.
- Crypto + short-selling + over-limit orders are hard-vetoed **before** any MCP call, regardless of mode.
