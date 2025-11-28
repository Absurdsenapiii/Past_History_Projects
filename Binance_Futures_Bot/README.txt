Binance Futures Monitor — Updated Build
======================================

What changed
------------
- Headers now mimic axios (browser-like) and enable Brotli if available.
- Robust JSON handling: logs non-JSON responses instead of crashing.
- Safer logging (no unterminated string literal).
- Default host set to https://fapi.binance.com for stability.

Setup
-----
1) (Recommended) create a venv:
   python -m venv .venv
   .venv\Scripts\activate      # Windows PowerShell

2) Install deps:
   pip install -r requirements.txt

3) Copy .env.example to .env and fill:
   - TELEGRAM_BOT_TOKEN
   - TELEGRAM_CHAT_ID
   (others can stay as defaults)

4) Run:
   python binance_futures_monitor.py

Notes
-----
- If you cannot install 'brotli', you can remove it from requirements;
  the monitor will still work but may receive fewer br-encoded responses.
- If you use a proxy/VPN, try disabling it or set NO_PROXY=*.binance.com
  in your .env to avoid HTML/blank bodies from intermediary gateways.
