# CandleRush — on-chain evidence (Solana devnet, 25 Nov 2026)

All transactions are on Solana **devnet**; the game rounds ran on the MagicBlock
**Ephemeral Rollup** (Asia validator, `https://devnet-as.magicblock.app`,
validator `MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57`) and settled back to
the base layer. Tx links are `https://explorer.solana.com/tx/<sig>?cluster=devnet`.

## Program deployment

- **Program ID:** `GiAkPEGUwF2HQuVQUatQbz2N8yzE2JfoofcxaBQujHdX`
  (https://explorer.solana.com/address/GiAkPEGUwF2HQuVQUatQbz2N8yzE2JfoofcxaBQujHdX?cluster=devnet)
- Owner: `BPFLoaderUpgradeab1e11111111111111111111111` (upgradeable), ProgramData
  `ES75gXrtPwYuWdqrt4rNDPAamTYMMECWejjtjHqT3iMD`, upgrade authority = the devnet
  burner `927VrDKzJnkrwHHcvA3mNcaTRKadvV1Yqq2FyP9T1nNV`. Verified on-chain with
  `solana program show` after every deploy (executable, data length matches the ELF).
- Initial deploy signature: `zoMuqQG5xRTRTth1hzhXNgUrGNfRnbbJUZVXN8QykN26DvWwGo2EDWgrTEcyEARwUwTgpvggzedaWG2B68ZjsXC` (slot 525,968,609)
- Two bug-fix upgrades followed during the live debugging below:
  `58YFfqaTD88Vg46QcXkmS2UCuj5wPVd5YCHXvorcYa3gbwhs8ZMuR81guk4NPDGgVzhubpgKL5j3ZqcuMBw69e12` (slot 525,969,149) and
  `4G278AYss6E5tkCzB8c8J8EEajcfoMFbDoAJwCJd5cmTVtC2jqyfpBUAphdyvEZZ9t7tUx8qtLuUNkqzp1XDMqKP` (slot 525,969,513, current).
- Environment note: this sandbox's egress proxy intercepts websocket traffic, so
  the CLI deploy was run with `--use-rpc` (the default TPU path panics when its
  pubsub client cannot connect), and the Node client confirms transactions by
  polling `getSignatureStatuses` over HTTP instead of websocket subscriptions.
  The first deploy attempt (before `--use-rpc`) left an empty buffer account;
  it was closed afterwards and its 1.0168 SOL rent reclaimed.

## Bugs found by the live run and fixed (why there are three deploys)

1. `joinRoom` failed with "Failed to serialize or deserialize account data":
   borsh `try_from_slice` rejects trailing bytes, and the state accounts are
   128/96 bytes while the structs serialize to 114/90. Fixed by parsing the
   exact serialized prefix (`ROOM_LEN`/`PLAYER_LEN`).
2. Player delegation then panicked at the same helper: reconstructing seeds
   tried the Room parse first, slicing a 96-byte Player account at byte 114.
   Fixed with length guards before each parse.
3. The first upgrade was rejected by the loader: `ExtendProgram` requires a
   minimum of 10,240 additional bytes. Extended the programdata once by
   10,240 bytes, then the upgrades went through.

Two half-finished rooms from the failed runs remain on devnet as debugging
artifacts (room ids 566212 and 566342; the latter's Room account is still
delegated). They hold only their small account rent.

## Lifecycle run — full game, two bots (room id 566422)

Room: `3bA7Fu7EYnrxRDHAzDYU8PJwx1HpZ8AtaQedTynXMrGE`
(https://explorer.solana.com/address/3bA7Fu7EYnrxRDHAzDYU8PJwx1HpZ8AtaQedTynXMrGE?cluster=devnet)
Players: bot1 `FyeB4iskezei9jEC2teEMTxoLbHBL8r2Gdwb5wh6Fzjk`, bot2 `Bn3jUJ7nVvQxqbeesuDRyRFSnE6cKsmMbdhr5azGgH37`

| Step | Signature |
| --- | --- |
| CreateRoom (base) | `2JNf2uVXMXe8t3Bo3tQCVfXAfrJuYcpowdUhGP8W44cWsJ8G7CUxSWFLBCb7TKQHHdz38YpnSEseCxWpTNPM5LRH` |
| JoinRoom bot1 (base) | `4UZezkbaY2aAxaUVd21gvh9QxLrM8E4yRwD6eZ5XBKNXTtiYHHeAZtJ9gHkyWGvbcK3Rt4rrd1aMNEhwv8W9Ag2B` |
| JoinRoom bot2 (base) | `q529ziw1WeRte6F2w4uv96jJCbfsPRKLSMiwRaXRnezASCPhehcGVZnpoz6cxaALpUUCofPj3jd1MBz6eToAd8U` |
| Delegate room (base) | `2ijM8msnHE8sZiGpaC5Fa5ddBrXP1mHUw1uyeHifgbdYDtVKG1v9kre2QF8oTvUhw2ueGiqhWzuCCMNMVzx4G8T1` |
| Delegate player1 (base) | `ADbQ22Lr43TaMHmEXGk7VZKSevSqN2DXxMahJSaswVkhzhn8UhcKxVALWxvJ4dvCfvhmQzFK2QBKP4nzJgNhgNX` |
| Delegate player2 (base) | `52d3EVQg6VnkxZrMapt6xfD3WsFk7uPu4FZyNpcYLbEAh4G1KEvpDGMSchn4B2jK5CvsLTEtPKp6dnkaKh6vCJ3F` |
| 24 taps (ER) | first `3e8nYPw21qpzcu7Mf82ZcJRtfvpPnzYiUH8BNsKmTAunmy159NfLXXv1pFqsAc9W7KAupVZkNZSZ1v4k1LMjQ1Gn`, last `2RB7CXyTUNYoChd38TUGUfnYuPhL6Ch3gXvuvcA14iuKz5PxqAgn3eEbe6PhwzsXxN7BfVZ5arrXf1W6owekY5hy` |
| EndRound (ER) | `46voRvYSkkaYKuWdQrhdDQPkk7ngBuTwEviEwfAsUBMWcG4P5RtNuxsT2u8kJfTZzHZzySmm2NANUfMppDuapQ7F` |
| Commit+undelegate room (ER) | `4h6Hqj26CQxfitX7uXzjUqWuJJjHJcNrbmJbLtwukWDUq3aASwKzASQDhEVCCok3Fu5w6k4ve2xA3KGSR7cPHGtc` |
| Commit+undelegate player1 (ER) | `32EuGkH9d5beJRrRJG21Fb8MPxVLAw1VKEpKNqQ2a1ZKbH8NxeA6wsEWvA3ChkxQ3Ds4NvqW8ZjgB6HpUmbowUUN` |
| Commit+undelegate player2 (ER) | `3wbbfedca4FrjykxTSqzGwp2678f8WeWhzCeBZRvko3RtAT9Phv3H77Zcj2jsvHxbVrKyeUafEGTSJfbCtLiGq6X` |

Results:
- ER final state: price **99.94**, tick **24**, longs 1, shorts 1; bot1 score **−1** (12 taps), bot2 score **31** (12 taps).
- The 24 sequential, individually confirmed taps took 16,687 ms total from this
  sandbox (≈0.7 s per confirmed tap). That number is dominated by the sandbox's
  HTTP egress proxy round trips and the client's 800 ms status-poll interval —
  it is a measurement of this environment, not of the ER (see the benchmark
  below, where the ER was never the bottleneck).
- **Base-layer settlement verified** by reading the room account on
  `api.devnet.solana.com` after undelegation: `status=1` (ended), price 9994,
  tick 24, **winner `Bn3jUJ7nVvQxqbeesuDRyRFSnE6cKsmMbdhr5azGgH37` (bot2),
  bestScore 31** — exactly the ER's final state, now owned by the program on
  the base layer again.

## Benchmark run — 30 taps back-to-back (room id 566481)

Room: `DW3GYckFDLX5f3Wuas3JYVAF6RZigPazy5FfcFeQXvHE`
(https://explorer.solana.com/address/DW3GYckFDLX5f3Wuas3JYVAF6RZigPazy5FfcFeQXvHE?cluster=devnet), single player (bot1).

- Taps were submitted without waiting for per-tap confirmation. Send
  round trips from this sandbox: min **185 ms**, median **375 ms**, max
  1,613 ms (proxy/network bound); all 30 submitted in 10,672 ms.
- ER state showed **all 30 taps applied 10,863 ms after the first send** —
  i.e. the final tap was applied ~0.2 s after it was submitted. From this
  environment the submission rate is the bottleneck, never ER execution.
  (MagicBlock's published ER block time is ~50 ms; we report only what we
  measured from here.)
- First tap `6291BgMw6Z5J4F3TdBg4jfQEa6wjEg9hrbLtswnRiciwYbbSZBb3SiDz5YQ4TBVc8s9zJLWm93jsrPMiizg55bUf`,
  last tap `2zvPF6gaeo3bRDLDWqiMBZ44XKFXwvmGkKsH1eiURuPz7zia9CUwUvmdbvDFN9XTYMsfk4C4GzxuMcNkEbvHbYdN`
  (last tap's status on the ER: finalized, ER slot 1,159,058,469).
- EndRound `4BbtvxzgDDjCnSk5Bd8QEdqmBGEhggS5r9fZVWgtRNfgt6ZCLWGfhW9P1VbkV7URXyjeMrHbx6BFsRJ4Lv1SWdK5`;
  commit+undelegate `35hfh394LyUHmZA6u3XLbwnXWm1R8aZtEoWmuWsAg7YnpusyrVcqiHXz68JK9SH83p62uHJtRXqDGBKAs8u6ygKn`
  and `5v5CfREskcjhZ8VykpcMKqwipuZgioP9qTdvXLVrci58onA9LFAPfdhpCrLL8Whgpm5PEfmUCKTfbDEejX4VRXE4`.
- Settled on base: `status=1`, price **100.30**, tick **30**, winner bot1,
  bestScore **85** — verified by a base-layer read.

## Web dashboard smoke test

- `web/index.html` serves correctly (HTTP 200) and its module script passes
  a syntax check.
- The dashboard's exact read logic (same RPC endpoints, same
  `getProgramAccounts` filters — dataSize 96 + room memcmp — and the same
  parse offsets) was executed against both live rooms above
  (`app/src/smoke-web.mjs`): room state and leaderboards returned the correct
  settled values for both rooms (24-tap game: scores 31 / −1; bench room:
  score 85, 30 taps).
- During the smoke pass the page's own code was hardened to not depend on a
  global `Buffer` (uses `Uint8Array`/`DataView` now), so it runs from the
  CDN ESM bundles it imports.
- Honest limit: the page was not click-tested in a real browser from this
  sandbox. Its play path uses the same instruction layouts the CLI exercised
  on-chain; the read path (chart + leaderboard) is verified against live state.

## SOL accounting (devnet, worthless test SOL)

- Burner faucet funding: 5.0 SOL. Final balances: burner **3.803779 SOL**,
  bot1 0.04657124 SOL, bot2 0.04771416 SOL (0.05 SOL funding each, minus their
  own tx fees). ~1.07 SOL remains as rent in the (extended) programdata
  account, and each room/player PDA holds ~0.0016–0.0018 SOL rent. Net
  transaction fees for the whole session were ≈0.02 SOL across ~120
  transactions (deploys, game setup, 54 ER taps, settlements). All orphan
  deploy buffers were closed and their rent reclaimed.
