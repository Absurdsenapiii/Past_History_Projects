# Archive Notes — Multi‑Wallet Mint Bot (Draft)

This repository is an **archived draft** of a multi‑wallet minting framework.
It is not production ready and is preserved mainly for reference and learning.

## What This Draft Tried To Do

- Generate N wallets and track them in a local SQLite + CSV combo.
- Prefund each wallet with ETH from a single funder wallet.
- Perform mints from each wallet against a target contract.
- Optionally sign USDC `transferWithAuthorization` messages.
- Watch contract events to mark wallets as “minted”.
- Consolidate ERC‑20 balances back to a main address.
- Refund leftover ETH into the funder wallet.

## Why It’s Not Finished

- Some modules still have rough edges and experimental code.
- The USDC authorization / relay flow is only partially implemented.
- Key management is dev‑oriented (CSV plaintext), not production grade.
- No formal tests or audits.

## If Rebuilt as v2

- Use encrypted keystores or an HSM instead of CSV plaintext keys.
- Add strong typing and tests.
- Improve separation of concerns and observability.
- Harden error handling and configuration validation.

## How To Treat This Repo

- As a snapshot of a past experiment, not a finished product.
- As a source of ideas / patterns, not drop‑in production code.
- Always do your own security review if you adapt anything here.
