# Phoenix API And SDK Reference

## Endpoints

| Surface | URL |
| --- | --- |
| REST | `https://perp-api.phoenix.trade` |
| WebSocket | `wss://perp-api.phoenix.trade/v1/ws` |
| OpenAPI | `https://docs.phoenix.trade/openapi/phoenix-public-api.json` |
| LLM index | `https://docs.phoenix.trade/llms.txt` |

## TypeScript SDK

Package: `@ellipsis-labs/rise`

Main exports:

- `createPhoenixClient`
- `PhoenixHttpClient`
- `createPhoenixWsClient`
- `createPhoenixWsFacade`
- `auth`
- `get`, `post`, `put`, `patch`, `del`
- `Side`, `Direction`, `StopLossOrderKind`
- `PhoenixHttpError`, `PhoenixAuthError`

Common client surfaces:

- `client.api`: typed REST route clients
- `client.pda`: PDA/address helpers
- `client.exchange`: exchange metadata cache
- `client.orderPackets`: metadata-backed order-packet builders
- `client.ixs`: instruction builders
- `client.streams`: WebSocket adapters
- `client.rpc`: raw account read surface
- `client.auth` and `client.sessionManager`: optional auth/session surfaces

Route groups under `client.api` include:

- `candles()`
- `collateral()`
- `exchange()`
- `funding()`
- `invite()`
- `markets()`
- `notifications()`
- `orderbook()`
- `orders()`
- `splines()`
- `traders()`
- `trades()`

## Rust SDK

Crate: `phoenix-rise`, import path `phoenix_rise`

Main surfaces:

- `PhoenixHttpClient`: typed REST client
- `PhoenixWSClient`: direct typed WebSocket subscriptions
- `PhoenixClient`: higher-level HTTP bootstrap plus reconnecting live runtime
- `PhoenixTxBuilder`: local transaction and instruction builder
- `PhoenixFlightClient`: beta Flight wrapper for supported order instructions
- `Trader`, `TraderKey`: trader state containers and PDA helpers

Useful Rust modules:

- `api`: REST route clients and payloads
- `accounts`: on-chain account fetchers and decoders
- `ix`: low-level instruction builders
- `math`: price, lots, margin, and risk helpers
- `types`: API, WebSocket, and account-backed types

## REST Categories

| Category | Use |
| --- | --- |
| Auth | Wallet, service, refresh, and logout sessions |
| Exchange | Exchange config, keys, markets, market config, snapshots, candles |
| Registration | Invite and referral activation |
| Trader | Trader state, PnL, collateral, funding, orders, trades, transaction builders |

Important REST routes:

- `GET /exchange`
- `GET /exchange/keys`
- `GET /exchange/markets`
- `GET /exchange/market/{symbol}`
- `GET /v1/exchange/snapshot`
- `GET /candles`
- `GET /trader/{authority}/state`
- `GET /trader/{authority}/pnl`
- `GET /trader/{authority}/collateral-history`
- `GET /trader/{authority}/funding-history`
- `GET /trader/{authority}/order-history`
- `GET /trader/{authority}/trades-history`
- `POST /v1/ix/place-isolated-limit-order`
- `POST /v1/ix/place-isolated-market-order`
- `POST /v1/ix/place-isolated-limit-order-enhanced`
- `POST /v1/ix/place-isolated-market-order-enhanced`
- `POST /v1/ix/cancel-conditional-order`
- `POST /v1/invite/activate`
- `POST /v1/invite/activate-with-referral`

## WebSocket Channels

Subscribe with:

```json
{
  "type": "subscribe",
  "subscription": {
    "channel": "orderbook",
    "symbol": "SOL"
  }
}
```

Unsubscribe with the same `subscription` object and `"type": "unsubscribe"`.

| Channel | Subscription fields | Response type |
| --- | --- | --- |
| `allMids` | none | all mid prices |
| `exchange` | optional `encoding` | exchange snapshot and deltas |
| `fundingRate` | `symbol` | funding rate update |
| `orderbook` | `symbol`, optional `bypassExecutionBand` | L2 book update |
| `traderState` | `authority`, `traderPdaIndex` | trader snapshot and deltas |
| `market` | `symbol` | market stats update |
| `trades` | `symbol` | trades update |
| `candles` | `symbol`, `timeframe` | candle update |

Supported candle timeframes: `1s`, `5s`, `1m`, `5m`, `15m`, `30m`, `1h`, `4h`, `1d`.

## Common Environment Variables

```bash
PHOENIX_API_URL=https://perp-api.phoenix.trade
PHOENIX_WS_URL=wss://perp-api.phoenix.trade/v1/ws
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
NEXT_PUBLIC_SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
```

