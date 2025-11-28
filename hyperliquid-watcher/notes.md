# Hyperliquid ERC20 Transfer Watcher

A lightweight real time blockchain watcher for Hyperliquid EVM that monitors ERC20 token transfers for a specific address and sends alerts to a Zapier webhook.

## Features
- Multi RPC auto selection based on block height and latency
- Batch log scanning to avoid timeouts
- ERC20 transfer decoding
- Token symbol auto detection with caching
- Duplicate transaction filtering
- Background queue and worker for webhook sending
- Fully asynchronous and non blocking design

## How It Works
The script continuously polls the latest block, retrieves ERC20 Transfer logs, filters transactions involving the target address, and sends structured JSON payloads to a Zapier endpoint for further automation.

No private keys or signing is required. This script is read only.

## Setup
1. Install dependencies:
