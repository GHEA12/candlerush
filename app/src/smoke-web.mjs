// Dashboard smoke test: replicates web/index.html's read path verbatim
// (same endpoints, same getProgramAccounts filters, same parse offsets)
// against live rooms, and asserts the rendered values would be correct.

import { Connection, PublicKey } from "@solana/web3.js";

// Route through the sandbox proxy like client.mjs does.
const proxyUrl =
  process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
if (proxyUrl) {
  const { ProxyAgent, setGlobalDispatcher } = await import("undici");
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
}

const PROGRAM_ID = new PublicKey("GiAkPEGUwF2HQuVQUatQbz2N8yzE2JfoofcxaBQujHdX");
const base = new Connection("https://api.devnet.solana.com", "confirmed");
const er = new Connection("https://devnet-as.magicblock.app", "confirmed");

// --- copied from web/index.html ---
function parseRoom(d) {
  return {
    price: Number(d.readBigUInt64LE(40)), tick: Number(d.readBigUInt64LE(48)),
    longs: Number(d.readBigUInt64LE(56)), shorts: Number(d.readBigUInt64LE(64)),
    status: d.readUInt8(72), winner: new PublicKey(d.subarray(73, 105)).toBase58(),
    bestScore: Number(d.readBigInt64LE(105)),
  };
}
function parsePlayer(d) {
  return {
    player: new PublicKey(d.subarray(0, 32)).toBase58(), position: d.readInt8(64),
    entryPrice: Number(d.readBigUInt64LE(65)), score: Number(d.readBigInt64LE(73)),
    taps: Number(d.readBigUInt64LE(81)),
  };
}
async function readRoom(room) {
  for (const [name, conn] of [["Ephemeral Rollup", er], ["Solana base layer", base]]) {
    try {
      const info = await conn.getAccountInfo(room);
      if (info && info.data.length >= 114) return { state: parseRoom(info.data), source: name };
    } catch { /* try next */ }
  }
  return null;
}
async function readPlayers(room) {
  for (const conn of [er, base]) {
    try {
      const accounts = await conn.getProgramAccounts(PROGRAM_ID, {
        filters: [{ dataSize: 96 }, { memcmp: { offset: 32, bytes: room.toBase58() } }],
      });
      if (accounts.length) return accounts.map((a) => parsePlayer(a.account.data));
    } catch { /* try next */ }
  }
  return [];
}
// --- end copy ---

const cases = [
  {
    name: "lifecycle room",
    room: new PublicKey("3bA7Fu7EYnrxRDHAzDYU8PJwx1HpZ8AtaQedTynXMrGE"),
    expect: { price: 9994, tick: 24, status: 1, bestScore: 31, winnerPrefix: "Bn3jUJ7n" },
    players: 2,
  },
  {
    name: "bench room",
    room: new PublicKey("DW3GYckFDLX5f3Wuas3JYVAF6RZigPazy5FfcFeQXvHE"),
    expect: { price: 10030, tick: 30, status: 1, bestScore: 85, winnerPrefix: "FyeB4isk" },
    players: 1,
  },
];

let failures = 0;
for (const c of cases) {
  const res = await readRoom(c.room);
  if (!res) {
    console.log(`${c.name}: ROOM NOT READABLE — FAIL`);
    failures++;
    continue;
  }
  const { state, source } = res;
  const ok =
    state.price === c.expect.price &&
    state.tick === c.expect.tick &&
    state.status === c.expect.status &&
    state.bestScore === c.expect.bestScore &&
    state.winner.startsWith(c.expect.winnerPrefix);
  console.log(
    `${c.name}: source=${source} price=${(state.price / 100).toFixed(2)} tick=${state.tick} status=${state.status} winner=${state.winner.slice(0, 8)}… best=${state.bestScore} — ${ok ? "OK" : "MISMATCH"}`,
  );
  if (!ok) failures++;
  const players = await readPlayers(c.room);
  players.sort((a, b) => b.score - a.score);
  console.log(
    `  leaderboard rows: ${players.length} (expected ${c.players}) ` +
      players.map((p) => `${p.player.slice(0, 8)}… score=${p.score} taps=${p.taps} pos=${p.position}`).join(" | "),
  );
  if (players.length !== c.players) failures++;
}
console.log(failures === 0 ? "SMOKE OK" : `SMOKE FAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
