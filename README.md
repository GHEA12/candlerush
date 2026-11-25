# CandleRush 🕯️

A real-time candle-trading game built for **Solana Blitz v10** (MagicBlock) — theme: *Entertainment Finance*.

A room's price starts at 100.00. Every player tap moves it: tap **LONG** and the price ticks up, tap **SHORT** and it ticks down. Each tap first settles your open position at the current price (score += direction × price change since entry), then opens a new position in your chosen direction and applies your price impact. Ride the momentum you and everyone else create. When the round ends, the highest score wins.

The catch: this loop is impossible on base-layer Solana. Dozens of state updates per round at 400 ms slots with per-tx fees would kill the game. So the Room and Player accounts are **delegated to a MagicBlock Ephemeral Rollup**, where taps execute in ~50 ms with zero fees — then the final state **commits and undelegates back to Solana devnet**, winner recorded on the base layer.

## Live pieces

- **Program (Solana devnet):** `GiAkPEGUwF2HQuVQUatQbz2N8yzE2JfoofcxaBQujHdX`
  Explorer: https://explorer.solana.com/address/GiAkPEGUwF2HQuVQUatQbz2N8yzE2JfoofcxaBQujHdX?cluster=devnet
- **Ephemeral Rollup:** devnet, Asia validator (`devnet-as.magicblock.app`, validator `MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57`)
- **Web dashboard:** `web/index.html` — watch any room live (price chart + leaderboard read from the ER), or join and tap with your own funded devnet keypair.
- **Played rooms (settled on devnet, read them in the dashboard):**
  - Two-bot game, 24 taps: https://explorer.solana.com/address/3bA7Fu7EYnrxRDHAzDYU8PJwx1HpZ8AtaQedTynXMrGE?cluster=devnet — final price 99.94, winner bot2, best score 31
  - Benchmark game, 30 taps back-to-back: https://explorer.solana.com/address/DW3GYckFDLX5f3Wuas3JYVAF6RZigPazy5FfcFeQXvHE?cluster=devnet — final price 100.30, best score 85
- **Full evidence:** [EVIDENCE.md](EVIDENCE.md) — deploy/upgrade signatures, every lifecycle transaction, benchmark numbers, and the SOL accounting.

## How it works

| Step | Where | What happens |
| --- | --- | --- |
| CreateRoom | Solana devnet | Authority creates the Room PDA (price 100.00, status open) |
| JoinRoom | Solana devnet | Each player gets a Player PDA (score 0, flat) |
| Delegate | Solana devnet | Room + Player PDAs are delegated via CPI to the Delegation Program for the ER validator |
| Tap | **Ephemeral Rollup** | Settle position → open new position → price impact (1–5 ticks). ~50 ms, zero fee |
| EndRound | **Ephemeral Rollup** | Authority records the winner (highest score) in the Room |
| CommitAndUndelegate | **Ephemeral Rollup** | Final state commits to Solana; account ownership returns to the program |

The program is **native Rust** (no Anchor) using MagicBlock's `ephemeral-rollups-sdk`: delegation CPI hooks, Magic-context commit/undelegate, and the standard undelegation callback (`[196, 28, 41, 206, 48, 37, 51, 167]`).

## Run it

Prereqs: Node 24, a devnet wallet with a few SOL (https://faucet.solana.com).

The client expects a keypair at `~/.config/solana/candlerush-burner.json`
(the room authority; override with `BURNER_KEYPAIR`). Bot players are
generated into `app/keys/` on first run and funded by the authority.

```bash
# 1. Deploy (toolchain: Rust + Solana CLI 3.1.9, cargo build-sbf)
cd program && cargo build-sbf
solana program deploy target/deploy/candlerush.so \
  --program-id candlerush-keypair.json \
  --keypair ~/.config/solana/candlerush-burner.json \
  --url https://api.devnet.solana.com
# (In proxied/sandboxed environments where websocket traffic is blocked,
#  add --use-rpc to the deploy; the Node client already confirms
#  transactions by polling getSignatureStatuses over HTTP.)

# 2. Full lifecycle proof: create -> join -> delegate -> play -> settle
cd ../app && npm install
node src/lifecycle.mjs            # prints every tx + final settled state
node src/bench.mjs 30             # 30 back-to-back ER taps, throughput numbers
node src/smoke-web.mjs            # verifies the dashboard's read path on live rooms

# 3. Watch it live
#    open web/index.html in a browser, paste the room address the CLI printed
#    (or serve the folder: npx serve web) — the chart reads from the ER.
```

## Layout

- `program/` — native Rust Solana program (Room/Player PDAs, tap engine, ER delegation/commit hooks)
- `app/` — TypeScript-free Node client: `src/client.mjs` (instruction builders + state parsers), `src/lifecycle.mjs` (end-to-end game with two bots), `src/bench.mjs` (ER throughput benchmark), `src/smoke-web.mjs` (dashboard read-path check)
- `web/` — single-file dashboard + optional in-browser play
- `EVIDENCE.md` — the live devnet run: signatures, settled state, measurements

## Game rules (exact)

- Price is stored ×100 (10000 = 100.00), clamped to [1.00, 10000.00].
- A tap's price impact is `1 + (tick mod 5)` ticks in the tap direction.
- Score settles only when you tap again: `score += position × (price_now − entry_price)`. Your last open position when the round ends is not settled — tap late, risk it.
- Winner = highest settled score among the room's players when the authority ends the round.

Built solo for Solana Blitz v10, 25–27 Nov 2026. Testnet only; no real funds.
