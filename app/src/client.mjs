// CandleRush client library — talks to the CandleRush program on Solana
// devnet and to the MagicBlock Ephemeral Rollup (devnet, Asia validator).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  DELEGATION_PROGRAM_ID,
  MAGIC_CONTEXT_ID,
  MAGIC_PROGRAM_ID,
  delegateBufferPdaFromDelegatedAccountAndOwnerProgram,
  delegationMetadataPdaFromDelegatedAccount,
  delegationRecordPdaFromDelegatedAccount,
} from "@magicblock-labs/ephemeral-rollups-sdk";

// Route Node's fetch through the sandbox egress proxy when one is configured.
const proxyUrl =
  process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
if (proxyUrl) {
  try {
    const { ProxyAgent, setGlobalDispatcher } = await import("undici");
    setGlobalDispatcher(new ProxyAgent(proxyUrl));
  } catch {
    /* undici unavailable — direct connection */
  }
}

export const PROGRAM_ID = new PublicKey("GiAkPEGUwF2HQuVQUatQbz2N8yzE2JfoofcxaBQujHdX");
export const BASE_RPC = process.env.BASE_RPC || "https://api.devnet.solana.com";
export const ER_RPC = process.env.ER_RPC || "https://devnet-as.magicblock.app";
export const ER_VALIDATOR = new PublicKey("MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57");

export const baseConnection = new Connection(BASE_RPC, "confirmed");
export const erConnection = new Connection(ER_RPC, "confirmed");

export function loadKeypair(file) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

export function burnerKeypair() {
  return loadKeypair(
    process.env.BURNER_KEYPAIR ||
      path.join(os.homedir(), ".config/solana/candlerush-burner.json"),
  );
}

export function roomPda(authority, roomId) {
  const idBuf = Buffer.alloc(8);
  idBuf.writeBigUInt64LE(BigInt(roomId));
  return PublicKey.findProgramAddressSync(
    [Buffer.from("room"), authority.toBuffer(), idBuf],
    PROGRAM_ID,
  )[0];
}

export function playerPda(room, player) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("player"), room.toBuffer(), player.toBuffer()],
    PROGRAM_ID,
  )[0];
}

// ---------------------------------------------------------------------------
// State parsing (borsh layout, fixed offsets — see program/src/lib.rs)
// ---------------------------------------------------------------------------

export function parseRoom(data) {
  return {
    authority: new PublicKey(data.subarray(0, 32)).toBase58(),
    roomId: Number(data.readBigUInt64LE(32)),
    price: Number(data.readBigUInt64LE(40)),
    tick: Number(data.readBigUInt64LE(48)),
    longs: Number(data.readBigUInt64LE(56)),
    shorts: Number(data.readBigUInt64LE(64)),
    status: data.readUInt8(72),
    winner: new PublicKey(data.subarray(73, 105)).toBase58(),
    bestScore: Number(data.readBigInt64LE(105)),
    bump: data.readUInt8(113),
  };
}

export function parsePlayer(data) {
  return {
    player: new PublicKey(data.subarray(0, 32)).toBase58(),
    room: new PublicKey(data.subarray(32, 64)).toBase58(),
    position: data.readInt8(64),
    entryPrice: Number(data.readBigUInt64LE(65)),
    score: Number(data.readBigInt64LE(73)),
    taps: Number(data.readBigUInt64LE(81)),
    bump: data.readUInt8(89),
  };
}

// ---------------------------------------------------------------------------
// Instruction builders
// ---------------------------------------------------------------------------

function tagBuf(tag, extra = Buffer.alloc(0)) {
  const t = Buffer.alloc(8);
  t.writeBigUInt64LE(BigInt(tag));
  return Buffer.concat([t, extra]);
}

export function createRoomIx(authority, room, roomId) {
  const idBuf = Buffer.alloc(8);
  idBuf.writeBigUInt64LE(BigInt(roomId));
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: room, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: tagBuf(0, idBuf),
  });
}

export function joinRoomIx(player, room, playerAccount) {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: player, isSigner: true, isWritable: true },
      { pubkey: room, isSigner: false, isWritable: false },
      { pubkey: playerAccount, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: tagBuf(1),
  });
}

export function delegateIx(payer, stateAccount) {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: stateAccount, isSigner: false, isWritable: true },
      { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
      {
        pubkey: delegateBufferPdaFromDelegatedAccountAndOwnerProgram(stateAccount, PROGRAM_ID),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: delegationRecordPdaFromDelegatedAccount(stateAccount),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: delegationMetadataPdaFromDelegatedAccount(stateAccount),
        isSigner: false,
        isWritable: true,
      },
      { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: tagBuf(2, ER_VALIDATOR.toBuffer()),
  });
}

export function tapIx(player, playerAccount, room, direction) {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: player, isSigner: true, isWritable: false },
      { pubkey: playerAccount, isSigner: false, isWritable: true },
      { pubkey: room, isSigner: false, isWritable: true },
    ],
    data: tagBuf(3, Buffer.from([direction & 0xff])),
  });
}

function magicIx(payer, stateAccount, tag) {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: stateAccount, isSigner: false, isWritable: true },
      { pubkey: MAGIC_CONTEXT_ID, isSigner: false, isWritable: true },
      { pubkey: MAGIC_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: tagBuf(tag),
  });
}

export const commitIx = (payer, state) => magicIx(payer, state, 4);
export const commitAndUndelegateIx = (payer, state) => magicIx(payer, state, 5);

export function endRoundIx(authority, room, winnerPlayerAccount) {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: room, isSigner: false, isWritable: true },
      { pubkey: winnerPlayerAccount, isSigner: false, isWritable: false },
    ],
    data: tagBuf(6),
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Confirm a signature by polling getSignatureStatuses over HTTP.
// (Websocket confirmation is unusable in proxied/sandboxed environments:
// the WS handshake gets intercepted, while plain JSON-RPC works fine.)
export async function confirmSignature(connection, sig, timeoutMs = 60000) {
  const started = Date.now();
  for (;;) {
    const { value } = await connection.getSignatureStatuses([sig], {
      searchTransactionHistory: true,
    });
    const st = value && value[0];
    if (st) {
      if (st.err) {
        throw new Error(`tx ${sig} failed on-chain: ${JSON.stringify(st.err)}`);
      }
      if (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized") {
        return st;
      }
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`tx ${sig} not confirmed within ${timeoutMs} ms`);
    }
    await sleep(800);
  }
}

export async function send(connection, ix, signers, label) {
  const tx = new Transaction().add(ix);
  const sig = await connection.sendTransaction(tx, signers, { skipPreflight: false });
  await confirmSignature(connection, sig);
  console.log(`  ${label}: ${sig}`);
  return sig;
}

export async function getRoom(connection, room) {
  const info = await connection.getAccountInfo(room);
  return info ? parseRoom(info.data) : null;
}

export async function getPlayer(connection, playerAccount) {
  const info = await connection.getAccountInfo(playerAccount);
  return info ? parsePlayer(info.data) : null;
}

export async function isDelegated(roomOrPlayer) {
  const info = await baseConnection.getAccountInfo(roomOrPlayer);
  return !!info && info.owner.equals(DELEGATION_PROGRAM_ID);
}

export async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
