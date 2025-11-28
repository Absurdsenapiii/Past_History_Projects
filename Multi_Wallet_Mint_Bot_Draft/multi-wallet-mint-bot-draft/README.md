# 🧪 Multi‑Wallet Mint Bot - DRAFT (Archived)

> **Status:** DRAFT • Experimental • Not production ready  
> This repo exists as an archive of a past project, not as polished production software.

This is a **multi‑wallet ERC‑20 minting framework (draft)** that automates:

- generating multiple wallets
- funding them with ETH
- executing ERC‑20 mints across all wallets
- optionally handling USDC EIP‑3009 `transferWithAuthorization` flows
- consolidating tokens back to a main wallet
- refunding leftover ETH
- watching on‑chain events to track progress

The code is preserved **as a draft**: some parts are rough, some flows may be incomplete, and it is not meant to be used with real funds.

## ⚠️ Warnings

- Do **not** use with mainnet funds.
- Private keys must live only in local files (`.env`, CSV, DB) which are gitignored.
- This was built as an experiment / learning tool and is not actively maintained.

## High‑Level Modules

- `src/index.js` — CLI entry point / command router
- `src/gas.js` — gas pricing, limits, bumping, monitoring helpers
- `src/generateWallets.js` — generate wallets and log them to CSV / tracker DB
- `src/funderSend.js` — fund wallets with ETH using a funder key and nonce manager
- `src/mintWorker.js` — perform mints from each wallet, with simulation and retries
- `src/payment.js` — USDC EIP‑3009 `transferWithAuthorization` authorizations (draft)
- `src/consolidate.js` — consolidate ERC‑20 token balances back to the funder
- `src/refundEth.js` — refund leftover ETH from wallets to the funder
- `src/watcher.js` — watch contract events and mark wallets as “minted”
- `src/logger.js` — CSV utilities for logging mints, refunds, etc.
- `src/tracker.js` — SQLite‑based tracker for wallet / tx state
- `src/utils.js` — validation, retry logic, Telegram alerts, helper functions
- `src/abi/erc20.json` — minimal ERC‑20 ABI

Configuration is externalized into:

- `.env` — RPC URL, funder private key, dry‑run flags, Telegram, etc.
- `config/settings.json` — contract address, mint function, gas settings, wallet counts, etc.

## Setup (Testnets / Local Only)

```bash
npm install
cp .env.example .env
cp config/settings.example.json config/settings.json
# then edit .env and config/settings.json with your own test values
```

## CLI Commands (draft)

```bash
npm run gen         # generate wallets
npm run fund        # fund wallets with ETH
npm run mint        # mint using each wallet
npm run consolidate # consolidate ERC-20 tokens
npm run refund      # refund leftover ETH
npm run status      # show tracker status
```

USDC authorization flow (when `paymentMode` is `usdcAuthorization`):

```bash
npm run pay         # sign USDC authorizations
npm run watch       # watch mint events on-chain
```

Dry‑run variants (no real transactions):

```bash
npm run dry:gen
npm run dry:fund
npm run dry:mint
npm run dry:consolidate
npm run dry:refund
```

## Why It’s Marked DRAFT

- Contains experimental patterns and rough edges.
- Not audited for security.
- Kept as a historical snapshot of a past multi‑wallet minting experiment.

For more context, see `ARCHIVE_NOTES.md`.
