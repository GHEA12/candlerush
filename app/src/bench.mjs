// CandleRush ER throughput/latency benchmark.
//
// Sets up a fresh room with one bot, delegates both accounts to the
// Ephemeral Rollup, then fires N taps back-to-back WITHOUT waiting for
// per-tap confirmation, and measures:
//   - per-send RPC acceptance time (sendTransaction round trip)
//   - wall time until the ER room state shows all N taps applied
//   - per-tap signature confirmation status/slot on the ER
// Finally ends the round and commits+undelegates so the room settles
// back on the base layer.
//
// Usage: node src/bench.mjs [taps]

import fs from "node:fs";
import path from "node:path";
import { Transaction } from "@solana/web3.js";
import {
  baseConnection,
  burnerKeypair,
  commitAndUndelegateIx,
  confirmSignature,
  createRoomIx,
  delegateIx,
  endRoundIx,
  erConnection,
  getRoom,
  isDelegated,
  joinRoomIx,
  loadKeypair,
  playerPda,
  roomPda,
  send,
  sleep,
} from "./client.mjs";

const N = Number(process.argv[2] || 30);
const burner = burnerKeypair();
const botFile = path.join(process.cwd(), "keys", "bot1.json");
const bot = loadKeypair(botFile);
const roomId = Number(Math.floor(Date.now() / 1000) % 1_000_000);
const room = roomPda(burner.publicKey, roomId);
const pda = playerPda(room, bot.publicKey);

console.log(`bench: room ${room.toBase58()} (id ${roomId}), bot ${bot.publicKey.toBase58()}`);

if (!(await baseConnection.getAccountInfo(room))) {
  await send(baseConnection, createRoomIx(burner.publicKey, room, roomId), [burner], "createRoom");
}
if (!(await baseConnection.getAccountInfo(pda))) {
  await send(baseConnection, joinRoomIx(bot.publicKey, room, pda), [bot], "joinRoom");
}
for (const account of [room, pda]) {
  if (!(await isDelegated(account))) {
    await send(baseConnection, delegateIx(burner.publicKey, account), [burner], "delegate");
  }
}
await sleep(3000);

const { tapIx } = await import("./client.mjs");
const sendDurations = [];
const sigs = [];
const t0 = Date.now();
for (let i = 0; i < N; i++) {
  const dir = i % 3 === 2 ? -1 : 1;
  const tx = new Transaction().add(tapIx(bot.publicKey, pda, room, dir));
  const s = Date.now();
  const sig = await erConnection.sendTransaction(tx, [bot], { skipPreflight: true });
  sendDurations.push(Date.now() - s);
  sigs.push(sig);
}
const tSent = Date.now();

// Poll ER state until every tap is applied (tick counts applied taps).
let appliedAt = null;
for (let i = 0; i < 120; i++) {
  const r = await getRoom(erConnection, room);
  if (r && r.tick >= N) {
    appliedAt = Date.now();
    break;
  }
  await sleep(100);
}
if (!appliedAt) throw new Error("taps did not all apply on the ER in time");

// Confirmation status of the last tap on the ER.
const lastStatus = await confirmSignature(erConnection, sigs[sigs.length - 1], 30000).catch(
  (e) => ({ error: e.message }),
);

const sorted = [...sendDurations].sort((a, b) => a - b);
const median = sorted[Math.floor(sorted.length / 2)];
console.log(`bench results (${N} taps, single player, devnet-as ER):`);
console.log(`  send round-trip ms: min=${sorted[0]} median=${median} max=${sorted[sorted.length - 1]}`);
console.log(`  all sends submitted in ${tSent - t0} ms`);
console.log(
  `  all ${N} taps applied on ER after ${appliedAt - t0} ms wall (${((appliedAt - t0) / N).toFixed(1)} ms/tap effective, ${(N / ((appliedAt - t0) / 1000)).toFixed(1)} taps/s)`,
);
console.log(`  last tap status on ER: ${JSON.stringify(lastStatus)}`);
console.log(`  first tap sig: ${sigs[0]}`);
console.log(`  last tap sig: ${sigs[sigs.length - 1]}`);

// Settle: end round + commit/undelegate.
await send(erConnection, endRoundIx(burner.publicKey, room, pda), [burner], "endRound");
for (const account of [room, pda]) {
  await send(erConnection, commitAndUndelegateIx(burner.publicKey, account), [burner], "commitAndUndelegate");
}
for (let i = 0; i < 30; i++) {
  await sleep(3000);
  if (!(await isDelegated(room))) {
    const settled = await getRoom(baseConnection, room);
    if (settled && settled.status === 1) {
      console.log(
        `  settled on base: status=${settled.status} price=${settled.price} tick=${settled.tick} winner=${settled.winner} bestScore=${settled.bestScore}`,
      );
      break;
    }
  }
}
console.log("bench room explorer:", `https://explorer.solana.com/address/${room.toBase58()}?cluster=devnet`);
