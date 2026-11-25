//! CandleRush — a real-time candle-trading game for Solana Blitz v10.
//!
//! A Room holds a price that every player tap moves. Players open LONG/SHORT
//! positions by tapping; each tap settles the tapper's open position at the
//! current price, opens a new one, and applies price impact. Room and Player
//! accounts are delegated to a MagicBlock Ephemeral Rollup so taps execute at
//! ~50 ms with zero fees, then state commits back to Solana devnet.
//!
//! Instruction format: 8-byte little-endian tag + borsh payload (native style,
//! following MagicBlock's native-Rust ER counter example).

use borsh::{BorshDeserialize, BorshSerialize};
use ephemeral_rollups_sdk::cpi::{
    delegate_account, undelegate_account, DelegateAccounts, DelegateConfig,
};
use ephemeral_rollups_sdk::ephem::{commit_accounts, commit_and_undelegate_accounts};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    msg,
    program::invoke_signed,
    program_error::ProgramError,
    pubkey::Pubkey,
    sysvar::{rent::Rent, Sysvar},
};
use solana_system_interface::instruction as system_instruction;

solana_program::declare_id!("GiAkPEGUwF2HQuVQUatQbz2N8yzE2JfoofcxaBQujHdX");

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

pub const ROOM_SEED: &[u8] = b"room";
pub const PLAYER_SEED: &[u8] = b"player";
pub const START_PRICE: u64 = 10_000; // 100.00 with 2 decimals
pub const MIN_PRICE: u64 = 100;
pub const MAX_PRICE: u64 = 1_000_000;

pub const ROOM_SPACE: usize = 128;
pub const PLAYER_SPACE: usize = 96;

// Exact borsh-serialized sizes. Account data is larger (ROOM_SPACE /
// PLAYER_SPACE), and borsh's try_from_slice rejects trailing bytes, so
// state must always be parsed from the exact prefix.
pub const ROOM_LEN: usize = 114; // 32+8+8+8+8+8+1+32+8+1
pub const PLAYER_LEN: usize = 90; // 32+32+1+8+8+8+1

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[derive(BorshSerialize, BorshDeserialize, Debug)]
pub struct Room {
    pub authority: Pubkey,
    pub room_id: u64,
    pub price: u64,
    pub tick: u64,
    pub longs: u64,
    pub shorts: u64,
    pub status: u8, // 0 = open, 1 = ended
    pub winner: Pubkey,
    pub best_score: i64,
    pub bump: u8,
}

#[derive(BorshSerialize, BorshDeserialize, Debug)]
pub struct Player {
    pub player: Pubkey,
    pub room: Pubkey,
    pub position: i8, // -1 short, 0 flat, +1 long
    pub entry_price: u64,
    pub score: i64,
    pub taps: u64,
    pub bump: u8,
}

// ---------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------

pub enum Ix {
    /// 0 — accounts: [authority(signer, mut), room(mut), system_program]
    CreateRoom { room_id: u64 },
    /// 1 — accounts: [player(signer, mut), room, player_pda(mut), system_program]
    JoinRoom,
    /// 2 — accounts: [payer(signer), state(mut), owner_program, buffer(mut),
    ///      delegation_record(mut), delegation_metadata(mut), delegation_program,
    ///      system_program]; payload: validator pubkey (32 bytes)
    Delegate { validator: Pubkey },
    /// 3 — accounts: [player(signer), player_pda(mut), room(mut)]
    Tap { direction: i8 },
    /// 4 — accounts: [payer(signer), state(mut), magic_context(mut), magic_program]
    Commit,
    /// 5 — accounts: [payer(signer), state(mut), magic_context(mut), magic_program]
    CommitAndUndelegate,
    /// 6 — accounts: [authority(signer), room(mut), winner_player_pda]
    EndRound,
    /// callback — accounts: [delegated_account(mut), buffer(mut), payer(mut), system_program]
    UndelegateCallback { seeds: Vec<Vec<u8>> },
}

#[derive(BorshDeserialize)]
struct CreateRoomPayload {
    room_id: u64,
}
#[derive(BorshDeserialize)]
struct TapPayload {
    direction: i8,
}
#[derive(BorshDeserialize)]
struct DelegatePayload {
    validator: Pubkey,
}
#[derive(BorshDeserialize)]
struct UndelegatePayload {
    seeds: Vec<Vec<u8>>,
}

fn unpack(input: &[u8]) -> Result<Ix, ProgramError> {
    if input.len() < 8 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let (disc, rest) = input.split_at(8);
    Ok(match disc {
        [0, 0, 0, 0, 0, 0, 0, 0] => Ix::CreateRoom {
            room_id: CreateRoomPayload::try_from_slice(rest)?.room_id,
        },
        [1, 0, 0, 0, 0, 0, 0, 0] => Ix::JoinRoom,
        [2, 0, 0, 0, 0, 0, 0, 0] => Ix::Delegate {
            validator: DelegatePayload::try_from_slice(rest)?.validator,
        },
        [3, 0, 0, 0, 0, 0, 0, 0] => Ix::Tap {
            direction: TapPayload::try_from_slice(rest)?.direction,
        },
        [4, 0, 0, 0, 0, 0, 0, 0] => Ix::Commit,
        [5, 0, 0, 0, 0, 0, 0, 0] => Ix::CommitAndUndelegate,
        [6, 0, 0, 0, 0, 0, 0, 0] => Ix::EndRound,
        [196, 28, 41, 206, 48, 37, 51, 167] => Ix::UndelegateCallback {
            seeds: UndelegatePayload::try_from_slice(rest)?.seeds,
        },
        _ => return Err(ProgramError::InvalidInstructionData),
    })
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    match unpack(data)? {
        Ix::CreateRoom { room_id } => create_room(program_id, accounts, room_id),
        Ix::JoinRoom => join_room(program_id, accounts),
        Ix::Delegate { validator } => delegate(program_id, accounts, validator),
        Ix::Tap { direction } => tap(program_id, accounts, direction),
        Ix::Commit => commit(program_id, accounts, false),
        Ix::CommitAndUndelegate => commit(program_id, accounts, true),
        Ix::EndRound => end_round(program_id, accounts),
        Ix::UndelegateCallback { seeds } => undelegate_callback(program_id, accounts, seeds),
    }
}

fn create_pda<'info>(
    payer: &AccountInfo<'info>,
    pda: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    space: usize,
    seeds: &[&[u8]],
    program_id: &Pubkey,
) -> ProgramResult {
    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(space);
    let bump = Pubkey::find_program_address(seeds, program_id).1;
    let mut signer_seeds: Vec<&[u8]> = seeds.to_vec();
    let bump_arr = [bump];
    signer_seeds.push(&bump_arr);
    invoke_signed(
        &system_instruction::create_account(payer.key, pda.key, lamports, space as u64, program_id),
        &[payer.clone(), pda.clone(), system_program.clone()],
        &[&signer_seeds],
    )
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

fn create_room(program_id: &Pubkey, accounts: &[AccountInfo], room_id: u64) -> ProgramResult {
    let it = &mut accounts.iter();
    let authority = next_account_info(it)?;
    let room_acc = next_account_info(it)?;
    let system_program = next_account_info(it)?;
    if !authority.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    let room_id_bytes = room_id.to_le_bytes();
    let seeds: &[&[u8]] = &[ROOM_SEED, authority.key.as_ref(), &room_id_bytes];
    let (pda, bump) = Pubkey::find_program_address(seeds, program_id);
    if pda != *room_acc.key {
        return Err(ProgramError::InvalidSeeds);
    }
    create_pda(authority, room_acc, system_program, ROOM_SPACE, seeds, program_id)?;
    let room = Room {
        authority: *authority.key,
        room_id,
        price: START_PRICE,
        tick: 0,
        longs: 0,
        shorts: 0,
        status: 0,
        winner: Pubkey::default(),
        best_score: 0,
        bump,
    };
    room.serialize(&mut &mut room_acc.try_borrow_mut_data()?[..])?;
    msg!("CandleRush room {} created at price {}", room_id, START_PRICE);
    Ok(())
}

fn join_room(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let it = &mut accounts.iter();
    let player = next_account_info(it)?;
    let room_acc = next_account_info(it)?;
    let player_acc = next_account_info(it)?;
    let system_program = next_account_info(it)?;
    if !player.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    let room = Room::try_from_slice(&room_acc.try_borrow_data()?[..ROOM_LEN])?;
    if room.status != 0 {
        return Err(ProgramError::InvalidAccountData);
    }
    let seeds: &[&[u8]] = &[PLAYER_SEED, room_acc.key.as_ref(), player.key.as_ref()];
    let (pda, bump) = Pubkey::find_program_address(seeds, program_id);
    if pda != *player_acc.key {
        return Err(ProgramError::InvalidSeeds);
    }
    create_pda(player, player_acc, system_program, PLAYER_SPACE, seeds, program_id)?;
    let state = Player {
        player: *player.key,
        room: *room_acc.key,
        position: 0,
        entry_price: 0,
        score: 0,
        taps: 0,
        bump,
    };
    state.serialize(&mut &mut player_acc.try_borrow_mut_data()?[..])?;
    msg!("CandleRush player joined room {}", room.room_id);
    Ok(())
}

/// Reconstruct a state account's PDA seeds from its stored state.
fn seeds_of(state_acc: &AccountInfo) -> Result<Vec<Vec<u8>>, ProgramError> {
    let data = state_acc.try_borrow_data()?;
    // Room and Player have different first fields; try Room layout first by
    // checking total structure: Room starts with authority+room_id; Player
    // starts with player+room pubkeys. We distinguish by trying Room parse
    // and verifying the derived PDA, then Player parse.
    // Guard each parse by the account's actual length: a Player account
    // (96 bytes) is shorter than ROOM_LEN, and slicing past the end would
    // panic instead of falling through to the Player parse.
    if data.len() >= ROOM_LEN {
        if let Ok(room) = Room::try_from_slice(&data[..ROOM_LEN]) {
            let seeds = vec![
                ROOM_SEED.to_vec(),
                room.authority.to_bytes().to_vec(),
                room.room_id.to_le_bytes().to_vec(),
            ];
            let (pda, _) = Pubkey::find_program_address(
                &seeds.iter().map(|s| s.as_slice()).collect::<Vec<_>>(),
                &crate::ID,
            );
            if pda == *state_acc.key {
                return Ok(seeds);
            }
        }
    }
    if data.len() >= PLAYER_LEN {
        if let Ok(player) = Player::try_from_slice(&data[..PLAYER_LEN]) {
            let seeds = vec![
                PLAYER_SEED.to_vec(),
                player.room.to_bytes().to_vec(),
                player.player.to_bytes().to_vec(),
            ];
            let (pda, _) = Pubkey::find_program_address(
                &seeds.iter().map(|s| s.as_slice()).collect::<Vec<_>>(),
                &crate::ID,
            );
            if pda == *state_acc.key {
                return Ok(seeds);
            }
        }
    }
    Err(ProgramError::InvalidAccountData)
}

fn delegate(_program_id: &Pubkey, accounts: &[AccountInfo], validator: Pubkey) -> ProgramResult {
    let it = &mut accounts.iter();
    let payer = next_account_info(it)?;
    let state = next_account_info(it)?;
    let owner_program = next_account_info(it)?;
    let buffer = next_account_info(it)?;
    let delegation_record = next_account_info(it)?;
    let delegation_metadata = next_account_info(it)?;
    let delegation_program = next_account_info(it)?;
    let system_program = next_account_info(it)?;
    let seeds = seeds_of(state)?;
    let seed_refs: Vec<&[u8]> = seeds.iter().map(|s| s.as_slice()).collect();
    delegate_account(
        DelegateAccounts {
            payer,
            pda: state,
            owner_program,
            buffer,
            delegation_record,
            delegation_metadata,
            delegation_program,
            system_program,
        },
        &seed_refs,
        DelegateConfig {
            commit_frequency_ms: 30_000,
            validator: Some(validator),
        },
    )?;
    msg!("CandleRush account delegated to ER validator {}", validator);
    Ok(())
}

fn tap(_program_id: &Pubkey, accounts: &[AccountInfo], direction: i8) -> ProgramResult {
    if direction != 1 && direction != -1 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let it = &mut accounts.iter();
    let player_signer = next_account_info(it)?;
    let player_acc = next_account_info(it)?;
    let room_acc = next_account_info(it)?;
    if !player_signer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    let mut room = Room::try_from_slice(&room_acc.try_borrow_data()?[..ROOM_LEN])?;
    if room.status != 0 {
        return Err(ProgramError::InvalidAccountData);
    }
    let mut player = Player::try_from_slice(&player_acc.try_borrow_data()?[..PLAYER_LEN])?;
    if player.player != *player_signer.key || player.room != *room_acc.key {
        return Err(ProgramError::InvalidAccountData);
    }

    // 1. Settle the open position at the current price.
    if player.position != 0 {
        let pnl = player.position as i64 * (room.price as i64 - player.entry_price as i64);
        player.score += pnl;
        if player.position > 0 {
            room.longs = room.longs.saturating_sub(1);
        } else {
            room.shorts = room.shorts.saturating_sub(1);
        }
    }
    // 2. Open the new position at the current price.
    player.position = direction;
    player.entry_price = room.price;
    player.taps += 1;
    if direction > 0 {
        room.longs += 1;
    } else {
        room.shorts += 1;
    }
    // 3. Apply price impact: 1..=5 ticks, rotating with the room tick count.
    let step = 1 + (room.tick % 5);
    let new_price = room.price as i64 + direction as i64 * step as i64;
    room.price = new_price.clamp(MIN_PRICE as i64, MAX_PRICE as i64) as u64;
    room.tick += 1;

    player.serialize(&mut &mut player_acc.try_borrow_mut_data()?[..])?;
    room.serialize(&mut &mut room_acc.try_borrow_mut_data()?[..])?;
    msg!(
        "tap dir={} price={} tick={} score={}",
        direction,
        room.price,
        room.tick,
        player.score
    );
    Ok(())
}

fn commit(_program_id: &Pubkey, accounts: &[AccountInfo], undelegate: bool) -> ProgramResult {
    let it = &mut accounts.iter();
    let payer = next_account_info(it)?;
    let state = next_account_info(it)?;
    let magic_context = next_account_info(it)?;
    let magic_program = next_account_info(it)?;
    if undelegate {
        commit_and_undelegate_accounts(payer, vec![state], magic_context, magic_program, None)?;
        msg!("CandleRush commit+undelegate scheduled");
    } else {
        commit_accounts(payer, vec![state], magic_context, magic_program, None)?;
        msg!("CandleRush commit scheduled");
    }
    Ok(())
}

fn end_round(_program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let it = &mut accounts.iter();
    let authority = next_account_info(it)?;
    let room_acc = next_account_info(it)?;
    let winner_acc = next_account_info(it)?;
    if !authority.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    let mut room = Room::try_from_slice(&room_acc.try_borrow_data()?[..ROOM_LEN])?;
    if room.authority != *authority.key {
        return Err(ProgramError::InvalidAccountData);
    }
    let winner = Player::try_from_slice(&winner_acc.try_borrow_data()?[..PLAYER_LEN])?;
    if winner.room != *room_acc.key {
        return Err(ProgramError::InvalidAccountData);
    }
    room.status = 1;
    room.winner = winner.player;
    room.best_score = winner.score;
    room.serialize(&mut &mut room_acc.try_borrow_mut_data()?[..])?;
    msg!(
        "CandleRush round ended. winner={} score={}",
        winner.player,
        winner.score
    );
    Ok(())
}

fn undelegate_callback(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    seeds: Vec<Vec<u8>>,
) -> ProgramResult {
    let it = &mut accounts.iter();
    let delegated_account = next_account_info(it)?;
    let buffer = next_account_info(it)?;
    let payer = next_account_info(it)?;
    let system_program = next_account_info(it)?;
    undelegate_account(
        delegated_account,
        program_id,
        buffer,
        payer,
        system_program,
        seeds,
    )?;
    msg!("CandleRush account undelegated");
    Ok(())
}
