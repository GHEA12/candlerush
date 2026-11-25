// CandleRush full-lifecycle proof:
//   create room (base) -> bots join (base) -> delegate room+players (base)
//   -> taps at ER speed (ER) -> end round (ER)
//   -> commit + undelegate (ER) -> verify final state settled on base layer.
//
// Usage: node src/lifecycle.mjs [roomId] [tapsPerBot]

import fs from "node:fs";
import path from "node:path";
import { Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction } from "@solana/web3.js";
import {
  baseConnection,
  burnerKeypair,
  commitAndUndelegateIx,
  confirmSignature,
  createRoomIx,
  delegateIx,
  endRoundIx,
  erConnection,
  getPlayer,
  getRoom,
  isDelegated,
  joinRoomIx,
  loadKeypair,
  playerPda,
  roomPda,
  send,
  sleep,
  tapIx,
} from "./client.mjs";

const roomId = Number(process.argv[2] || Math.floor(Date.now() / 1000) % 1_000_000);
const tapsPerBot = Number(process.argv[3] || 12);
const keysDir = path.join(process.cwd(), "keys");
fs.mkdirSync(keysDir, { recursive: true });

function botKeypair(name) {
  const file = path.join(keysDir, `${name}.json`);
  if (fs.existsSync(file)) return loadKeypair(file);
  const kp = Keypair.generate();
  fs.writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
  return kp;
}

const burner = burnerKeypair();
const bot1 = botKeypair("bot1");
const bot2 = botKeypair("bot2");
const bots = [bot1, bot2];

console.log("CandleRush lifecycle");
console.log("  authority/burner:", burner.publicKey.toBase58());
const balance = await baseConnection.getBalance(burner.publicKey);
console.log("  burner balance:", balance / LAMPORTS_PER_SOL, "SOL");
if (balance < 0.5 * LAMPORTS_PER_SOL) {
  console.error(
    "\nBurner is underfunded. Get devnet SOL from https://faucet.solana.com to:",
    burner.publicKey.toBase58(),
  );
  process.exit(2);
}

const room = roomPda(burner.publicKey, roomId);
console.log("  room:", room.toBase58(), "roomId:", roomId);

// 1. Create room on base layer (skip if it already exists)
if (!(await baseConnection.getAccountInfo(room))) {
  await send(baseConnection, createRoomIx(burner.publicKey, room, roomId), [burner], "createRoom");
} else {
  console.log("  room already exists, reusing");
}

// 2. Fund bots + join
for (const bot of bots) {
  const bal = await baseConnection.getBalance(bot.publicKey);
  if (bal < 0.02 * LAMPORTS_PER_SOL) {
    const fundTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: burner.publicKey,
        toPubkey: bot.publicKey,
        lamports: 0.05 * LAMPORTS_PER_SOL,
      }),
    );
    const sig = await baseConnection.sendTransaction(fundTx, [burner]);
    await confirmSignature(baseConnection, sig);
    console.log("  funded bot", bot.publicKey.toBase58(), sig);
  }
  const pda = playerPda(room, bot.publicKey);
  if (!(await baseConnection.getAccountInfo(pda))) {
    await send(baseConnection, joinRoomIx(bot.publicKey, room, pda), [bot], "joinRoom");
  }
}

// 3. Delegate room + players to the ER validator
for (const account of [room, ...bots.map((b) => playerPda(room, b.publicKey))]) {
  if (!(await isDelegated(account))) {
    await send(baseConnection, delegateIx(burner.publicKey, account), [burner], `delegate ${account.toBase58().slice(0, 8)}…`);
  }
}
console.log("  delegated: room +", bots.length, "players");

// Give the ER a moment to clone the delegated accounts.
await sleep(3000);

// 4. Play on the ER: alternating taps, bot1 leans long, bot2 leans short.
console.log(`  playing ${tapsPerBot * bots.length} taps on the Ephemeral Rollup…`);
const started = Date.now();
for (let i = 0; i < tapsPerBot; i++) {
  for (const [idx, bot] of bots.entries()) {
    const dir = idx === 0 ? (i % 4 === 3 ? -1 : 1) : i % 4 === 3 ? 1 : -1;
    const pda = playerPda(room, bot.publicKey);
    const txStart = Date.now();
    await send(erConnection, tapIx(bot.publicKey, pda, room, dir), [bot], `tap#${i * 2 + idx + 1} (${Date.now() - txStart} ms send)`);
  }
}
const elapsed = Date.now() - started;
const erRoom = await getRoom(erConnection, room);
console.log(
  `  ER final: price=${erRoom.price} tick=${erRoom.tick} longs=${erRoom.longs} shorts=${erRoom.shorts} in ${elapsed} ms total`,
);
for (const bot of bots) {
  const p = await getPlayer(erConnection, playerPda(room, bot.publicKey));
  console.log(`    bot ${bot.publicKey.toBase58().slice(0, 8)}… score=${p.score} taps=${p.taps} position=${p.position}`);
}

// 5. End the round on the ER (winner = higher score)
const scores = [];
for (const bot of bots) {
  const p = await getPlayer(erConnection, playerPda(room, bot.publicKey));
  scores.push({ bot, pda: playerPda(room, bot.publicKey), score: p.score });
}
scores.sort((a, b) => b.score - a.score);
await send(erConnection, endRoundIx(burner.publicKey, room, scores[0].pda), [burner], "endRound");

// 6. Commit + undelegate everything
for (const account of [room, ...bots.map((b) => playerPda(room, b.publicKey))]) {
  await send(erConnection, commitAndUndelegateIx(burner.publicKey, account), [burner], "commitAndUndelegate");
}

// 7. Wait for settlement on the base layer and verify
console.log("  waiting for base-layer settlement…");
let settled = null;
for (let i = 0; i < 30; i++) {
  await sleep(3000);
  if (!(await isDelegated(room))) {
    settled = await getRoom(baseConnection, room);
    if (settled && settled.status === 1) break;
  }
}
if (!settled) throw new Error("room did not settle back on the base layer in time");
console.log(
  `  BASE final: status=${settled.status} price=${settled.price} tick=${settled.tick} winner=${settled.winner} bestScore=${settled.bestScore}`,
);
const winnerBot = bots.find((b) => b.publicKey.toBase58() === settled.winner);
console.log(
  winnerBot
    ? `  winner is ${winnerBot === bot1 ? "bot1" : "bot2"} — lifecycle OK`
    : "  WARNING: winner does not match a bot",
);
console.log("Room explorer:", `https://explorer.solana.com/address/${room.toBase58()}?cluster=devnet`);
