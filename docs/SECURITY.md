# Security

rh-trader holds brokerage credentials and can place real orders. Treat the machine it runs on
as the security boundary.

## Secrets never go in git

All credentials live in `.env`, which is gitignored, along with `.env.*` (the example is the
only exception), `*.key`, `*.pem`, `secrets/`, `backend/data/` (the OAuth token store), SQL
dumps, and any file matching `*token*.json`, `*credential*.json` or `*secret*.json`. The
ignore rules are patterns rather than filenames, so a new dump or a renamed key file is caught
too.

Before you commit anything, `git status --porcelain` should show no `.env` and no token file.
If a key ever reaches a commit, rotate it at the provider first and rewrite history second.
Rotating is the part that actually protects you.

Robinhood OAuth tokens are stored in `backend/data/oauth-tokens.json` and in the `oauth_tokens`
table of your local database. Both are local, both are ignored by git, and neither is
encrypted at rest. Full-disk encryption is the right control there.

## Local only by default

The backend binds `127.0.0.1` and there is no authentication layer, because a loopback socket
has nothing to authenticate. That assumption breaks the moment the port is reachable from
elsewhere. Do not bind it to `0.0.0.0`, do not port-forward it, and do not put it behind a
public reverse proxy as it stands. Anyone who can reach the port can place orders.

The database should be equally local. If you can, give it a dedicated user limited to
`rh_tradingbot` rather than reusing `root`.

## The kill switch

`POST /api/kill` (and the toggle on the Settings page) blocks all new order placement
regardless of mode, at the risk engine and again at the broker boundary. It deliberately
still allows close-only sells, so stop-losses, take-profits, trailing stops and flatten-before-
close keep protecting open positions while it is engaged. A switch that froze exits would be a
hazard rather than a safety feature.

The other levers, in order of bluntness: set the global mode to `observe`, disable individual
bots, switch the trading environment back to `alpaca_paper`, and disconnect the agent from the
Robinhood app, which revokes access at the broker.

## Reporting a problem

Open an issue at <https://github.com/erichers/rh-trader/issues> for anything non-sensitive.

For a vulnerability that could move money or leak credentials, do not open a public issue.
Use GitHub's private vulnerability reporting on the repository (Security tab, Report a
vulnerability) and include what you did, what happened, and what you expected. Expect a reply
within a week. This is a personal project with no bounty program and no formal SLA.

Please do not test findings against a funded live account. Reproduce them in `alpaca_paper`,
where the money is not real.
