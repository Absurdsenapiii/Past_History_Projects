# Binance Futures Signal Bot

A simple Telegram alert bot I built in my early era.  
It monitored Binance Futures markets for sudden short-term price movements and sent formatted alerts to Telegram.

## What it did
- Pulled Binance Futures price data every few seconds
- Detected large 5-minute moves (for example +6 percent or -5 percent)
- Calculated price difference, percentage change, and 24h volume
- Auto-sent alerts to Telegram using a bot token
- Included a link to the Binance Futures chart and preview card

## Example Alert
🚀 ALTUSDT +6.29 percent in 5m  
Price: 0.01575 → 0.01674  
Vol (24h): $23,390,542  
https://www.binance.com/en/futures/ALTUSDT

## Notes
This bot is archived for historical reference only.  
It represents my early experimentation period before I developed structured research workflows.
