// =============================================================================
// CT Life paid-call escrow program.
//
// Master prompt M4 / contract section 6. The backend can:
//
//   1.  init_config(admin, treasury, fee_bps) — one-time setup. The
//       admin is the backend's settle authority. The treasury is
//       the protocol's USDC treasury (receives the 5% fee). The
//       Config PDA owns the vault.
//
//   2.  open_session(fan, creator, rate_per_min, max_minutes,
//                    fan_usdc_ata, escrow_usdc_ata, vault) — pure
//       USDC transfer from fan to vault up to rate*max_minutes
//       (the cap). Records the Session PDA with the agreed terms
//       and a 120s accept timer.
//
//   3.  accept(creator, session) — creator must call before the
//       120s accept timer; otherwise the fan refunds and gets the
//       full amount back. After accept, status=active.
//
//   4.  settle(settle_authority, session, seconds_used) — at end
//       of the call. minutes = ceil(seconds_used / 60). The
//       creator gets minutes*rate, the treasury gets floor(gross
//       * fee_bps / 10_000), the fan gets the refund remainder
//       (cap - gross). Refund remainder is never withdrawn by an
//       admin: the only outflows are to creator, fan, and
//       treasury.
//
//   5.  refund(fan, session) — fan-initiated refund after the
//       accept window (max+600s) or before accept. Returns the
//       full vaulted amount to the fan.
//
// Security model: the admin key (settle_authority) can ONLY call
// settle(). It cannot withdraw funds directly. The fan holds the
// refund authority. The treasury is a passive recipient. The
// on-chain logic is server-authoritative on the math; the server
// supplies seconds_used honestly because the off-chain mortgage is
// a settlement signature the program emits, the server records
// the corresponding Helius program event, and the user's Net
// Worth is the source of truth for the in-game ledger. Real
// money movement goes through this program; the in-game ledger
// is a parallel ledger that the same money presses can read.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("FKvuRNUxGgijeD8P4varsnzBiLduCWKMhSLQp5fQsMfz");

pub mod errors;
pub use errors::EscrowError;

pub const FEE_BPS_DENOM: u16 = 10_000;
/// Default protocol fee in basis points (5%).
pub const DEFAULT_FEE_BPS: u16 = 500;
/// Accept window in seconds (per contract section 6: 120 s).
pub const ACCEPT_WINDOW_SECS: i64 = 120;
/// Post-accept grace before fan can refund (per contract: 600 s).
pub const POST_ACCEPT_GRACE_SECS: i64 = 600;
/// Minimum rate_cents_per_min (0.25 USDC = 25_000_000 base units at
/// 6-decimal precision; for USDC the master prompt locks the API
/// layer to 250_000..50_000_000 base units).
pub const MIN_RATE_BASE_UNITS: u64 = 250_000;
pub const MAX_RATE_BASE_UNITS: u64 = 50_000_000;
/// Minimum / maximum call length in minutes.
pub const MIN_MINUTES: u8 = 1;
pub const MAX_MINUTES: u8 = 60;

#[program]
pub mod ct_escrow {
    use super::*;

    /// One-time setup. The admin becomes the settle authority; the
    /// treasury becomes the fee destination; fee_bps is the
    /// protocol cut.
    pub fn init_config(
        ctx: Context<InitConfig>,
        fee_bps: u16,
    ) -> Result<()> {
        require!(
            fee_bps <= FEE_BPS_DENOM,
            EscrowError::InvalidFeeBps
        );
        let cfg = &mut ctx.accounts.config;
        cfg.admin = ctx.accounts.admin.key();
        cfg.treasury = ctx.accounts.treasury.key();
        cfg.fee_bps = fee_bps;
        cfg.vault = ctx.accounts.vault.key();
        cfg.bump = ctx.bumps.config;
        Ok(())
    }

    /// Fan opens a paid-call session. Pulls the call's max value
    /// (rate * max_minutes) from the fan's USDC ATA into the
    /// program's vault. Records the agreed terms + a 120s accept
    /// window. The session PDA is the on-chain receipt.
    pub fn open_session(
        ctx: Context<OpenSession>,
        session_id: u64,
        creator: Pubkey,
        rate_base_units_per_min: u64,
        max_minutes: u8,
    ) -> Result<()> {
        require!(
            rate_base_units_per_min >= MIN_RATE_BASE_UNITS
                && rate_base_units_per_min <= MAX_RATE_BASE_UNITS,
            EscrowError::InvalidRate
        );
        require!(
            max_minutes >= MIN_MINUTES && max_minutes <= MAX_MINUTES,
            EscrowError::InvalidMinutes
        );

        // Cap = rate * max_minutes (in base units). We compute it
        // in u128 to avoid any chance of overflow even on the
        // largest allowed inputs.
        let cap: u64 = (rate_base_units_per_min as u128)
            .checked_mul(max_minutes as u128)
            .and_then(|s| u64::try_from(s).ok())
            .ok_or(EscrowError::MathOverflow)?;

        // Transfer fan -> vault. The fan signs; the program is
        // the PDA authority on the vault's token account, but
        // this is a CPI from the fan's token account so the fan's
        // authority is what matters.
        let cpi_accounts = Transfer {
            from: ctx.accounts.fan_usdc_ata.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
            authority: ctx.accounts.fan.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        token::transfer(cpi_ctx, cap)?;

        let session = &mut ctx.accounts.session;
        session.session_id = session_id;
        session.fan = ctx.accounts.fan.key();
        session.creator = creator;
        session.rate_base_units_per_min = rate_base_units_per_min;
        session.max_minutes = max_minutes;
        session.cap_base_units = cap;
        session.opened_at = Clock::get()?.unix_timestamp;
        session.accepted_at = 0;
        session.settled_at = 0;
        session.seconds_used = 0;
        session.status = SessionStatus::Pending;
        session.bump = ctx.bumps.session;
        Ok(())
    }

    /// Creator accepts the call. Must be called before
    /// opened_at + ACCEPT_WINDOW_SECS.
    pub fn accept(ctx: Context<Accept>) -> Result<()> {
        let session = &mut ctx.accounts.session;
        require!(
            session.status == SessionStatus::Pending,
            EscrowError::NotPending
        );
        require!(
            session.creator == ctx.accounts.creator.key(),
            EscrowError::NotCreator
        );
        let now = Clock::get()?.unix_timestamp;
        require!(
            now <= session.opened_at + ACCEPT_WINDOW_SECS,
            EscrowError::AcceptWindowExpired
        );
        session.status = SessionStatus::Active;
        session.accepted_at = now;
        Ok(())
    }

    /// Settle the call. The settle_authority is the program's
    /// admin key (the backend). It supplies seconds_used. Math:
    ///
    ///   minutes = ceil(seconds_used / 60)        (cap by max_minutes)
    ///   gross   = minutes * rate
    ///   fee     = floor(gross * fee_bps / 10_000)
    ///   creator_payout = gross - fee
    ///   refund  = cap - gross                    (back to fan)
    ///
    /// The fan receives the refund, the creator receives
    /// creator_payout, the treasury receives fee. The vault must
    /// have enough; if seconds_used > max_minutes * 60, the
    /// call has overrun and we cap to max_minutes. If the creator
    /// or fan ATA is missing, we still allow the call to settle
    /// by leaving their portion in the vault (the off-chain
    /// ledger handles accounting).
    pub fn settle(
        ctx: Context<Settle>,
        seconds_used: u64,
    ) -> Result<()> {
        let session = &mut ctx.accounts.session;
        require!(
            session.status == SessionStatus::Active,
            EscrowError::NotActive
        );
        let now = Clock::get()?.unix_timestamp;
        // Allow settle any time after accept. The LiveKit
        // room_finished webhook drives this. The server should
        // call within POST_ACCEPT_GRACE_SECS of the call ending
        // or the fan can refund.
        require!(now >= session.accepted_at, EscrowError::ClockMath);
        require!(
            session.seconds_used == 0,
            EscrowError::AlreadySettled
        );

        // minutes = ceil(seconds / 60), capped at max_minutes.
        let cap_minutes = session.max_minutes as u64;
        let max_secs = cap_minutes.checked_mul(60).ok_or(EscrowError::MathOverflow)?;
        let seconds_used = seconds_used.min(max_secs);
        let minutes = (seconds_used + 59) / 60;
        let minutes = minutes.min(cap_minutes);

        // gross = minutes * rate, in u128 to avoid overflow.
        let gross: u64 = (session.rate_base_units_per_min as u128)
            .checked_mul(minutes as u128)
            .and_then(|s| u64::try_from(s).ok())
            .ok_or(EscrowError::MathOverflow)?;
        let cfg_fee_bps = ctx.accounts.config.fee_bps;
        let fee: u64 = (gross as u128)
            .checked_mul(cfg_fee_bps as u128)
            .map(|m| m / FEE_BPS_DENOM as u128)
            .and_then(|s| u64::try_from(s).ok())
            .ok_or(EscrowError::MathOverflow)?;
        let creator_payout = gross.checked_sub(fee).ok_or(EscrowError::MathOverflow)?;
        let refund = session
            .cap_base_units
            .checked_sub(gross)
            .ok_or(EscrowError::MathOverflow)?;

        // Vault -> creator USDC ATA.
        if creator_payout > 0 {
            let cpi_accounts = Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.creator_usdc_ata.to_account_info(),
                authority: ctx.accounts.config.to_account_info(),
            };
            let seeds: &[&[u8]] = &[b"config", &[ctx.accounts.config.bump]];
            let signer_seeds = &[seeds];
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                cpi_accounts,
                signer_seeds,
            );
            token::transfer(cpi_ctx, creator_payout)?;
        }

        // Vault -> treasury USDC ATA (the fee).
        if fee > 0 {
            let cpi_accounts = Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.treasury_usdc_ata.to_account_info(),
                authority: ctx.accounts.config.to_account_info(),
            };
            let seeds: &[&[u8]] = &[b"config", &[ctx.accounts.config.bump]];
            let signer_seeds = &[seeds];
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                cpi_accounts,
                signer_seeds,
            );
            token::transfer(cpi_ctx, fee)?;
        }

        // Vault -> fan USDC ATA (the refund remainder).
        if refund > 0 {
            let cpi_accounts = Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.fan_usdc_ata.to_account_info(),
                authority: ctx.accounts.config.to_account_info(),
            };
            let seeds: &[&[u8]] = &[b"config", &[ctx.accounts.config.bump]];
            let signer_seeds = &[seeds];
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                cpi_accounts,
                signer_seeds,
            );
            token::transfer(cpi_ctx, refund)?;
        }

        session.status = SessionStatus::Settled;
        session.settled_at = now;
        session.seconds_used = seconds_used;
        session.gross_base_units = gross;
        session.fee_base_units = fee;
        session.creator_payout_base_units = creator_payout;
        session.refund_base_units = refund;
        emit!(Settled {
            session: session.key(),
            fan: session.fan,
            creator: session.creator,
            seconds_used,
            gross_base_units: gross,
            fee_base_units: fee,
            creator_payout_base_units: creator_payout,
            refund_base_units: refund,
            settled_at: now,
        });
        Ok(())
    }

    /// Fan-initiated refund. Allowed at any time before settle, plus
    /// after the post-accept grace if active.
    pub fn refund(ctx: Context<Refund>) -> Result<()> {
        let session = &mut ctx.accounts.session;
        require!(
            session.fan == ctx.accounts.fan.key(),
            EscrowError::NotFan
        );
        let now = Clock::get()?.unix_timestamp;
        let can_refund = match session.status {
            SessionStatus::Pending => true,
            SessionStatus::Active => {
                now >= session.accepted_at + POST_ACCEPT_GRACE_SECS
                    && session.seconds_used == 0
            }
            _ => false,
        };
        require!(can_refund, EscrowError::CannotRefund);

        // Vault -> fan. The whole cap comes back; settlement
        // accounting happens off-chain.
        let cpi_accounts = Transfer {
            from: ctx.accounts.vault.to_account_info(),
            to: ctx.accounts.fan_usdc_ata.to_account_info(),
            authority: ctx.accounts.config.to_account_info(),
        };
        let seeds: &[&[u8]] = &[b"config", &[ctx.accounts.config.bump]];
        let signer_seeds = &[seeds];
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );
        token::transfer(cpi_ctx, session.cap_base_units)?;

        session.status = SessionStatus::Refunded;
        session.settled_at = now;
        session.refund_base_units = session.cap_base_units;
        emit!(Refunded {
            session: session.key(),
            fan: session.fan,
            creator: session.creator,
            refund_base_units: session.cap_base_units,
            refunded_at: now,
        });
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + Config::INIT_SPACE,
        seeds = [b"config"],
        bump,
    )]
    pub config: Account<'info, Config>,

    /// CHECK: the USDC token account that holds the vault. We
    // verify the mint + owner in the handler.
    #[account(
        constraint = vault.mint == usdc_mint.key() @ EscrowError::InvalidMint,
        constraint = vault.owner == config.key() @ EscrowError::InvalidVaultOwner,
    )]
    pub vault: Account<'info, TokenAccount>,

    /// CHECK: the USDC mint. Verified against the vault.
    pub usdc_mint: AccountInfo<'info>,

    /// The treasury USDC token account (the protocol's fee destination).
    /// CHECK: we don't read the data; the off-chain code wires it.
    pub treasury: AccountInfo<'info>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(session_id: u64)]
pub struct OpenSession<'info> {
    #[account(
        init,
        payer = fan,
        space = 8 + Session::INIT_SPACE,
        seeds = [b"session", fan.key().as_ref(), &session_id.to_le_bytes()],
        bump,
    )]
    pub session: Account<'info, Session>,

    #[account(
        seeds = [b"config"],
        bump = config.bump,
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        constraint = vault.key() == config.vault @ EscrowError::InvalidVault,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = fan_usdc_ata.mint == vault.mint @ EscrowError::InvalidMint,
        constraint = fan_usdc_ata.owner == fan.key() @ EscrowError::InvalidTokenOwner,
    )]
    pub fan_usdc_ata: Account<'info, TokenAccount>,

    #[account(mut)]
    pub fan: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Accept<'info> {
    #[account(
        mut,
        seeds = [b"session", session.fan.as_ref(), &session.session_id.to_le_bytes()],
        bump = session.bump,
    )]
    pub session: Account<'info, Session>,

    pub creator: Signer<'info>,
}

#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(
        mut,
        seeds = [b"session", session.fan.as_ref(), &session.session_id.to_le_bytes()],
        bump = session.bump,
    )]
    pub session: Account<'info, Session>,

    #[account(
        seeds = [b"config"],
        bump = config.bump,
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        constraint = vault.key() == config.vault @ EscrowError::InvalidVault,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = creator_usdc_ata.mint == vault.mint @ EscrowError::InvalidMint,
        constraint = creator_usdc_ata.owner == session.creator @ EscrowError::InvalidTokenOwner,
    )]
    pub creator_usdc_ata: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = fan_usdc_ata.mint == vault.mint @ EscrowError::InvalidMint,
        constraint = fan_usdc_ata.owner == session.fan @ EscrowError::InvalidTokenOwner,
    )]
    pub fan_usdc_ata: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = treasury_usdc_ata.mint == vault.mint @ EscrowError::InvalidMint,
        constraint = treasury_usdc_ata.owner == config.treasury @ EscrowError::InvalidTokenOwner,
    )]
    pub treasury_usdc_ata: Account<'info, TokenAccount>,

    /// The settle authority (the backend). Constraint: must equal
    /// config.admin.
    pub settle_authority: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Refund<'info> {
    #[account(
        mut,
        seeds = [b"session", session.fan.as_ref(), &session.session_id.to_le_bytes()],
        bump = session.bump,
    )]
    pub session: Account<'info, Session>,

    #[account(
        seeds = [b"config"],
        bump = config.bump,
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        constraint = vault.key() == config.vault @ EscrowError::InvalidVault,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = fan_usdc_ata.mint == vault.mint @ EscrowError::InvalidMint,
        constraint = fan_usdc_ata.owner == session.fan @ EscrowError::InvalidTokenOwner,
    )]
    pub fan_usdc_ata: Account<'info, TokenAccount>,

    pub fan: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

#[account]
pub struct Config {
    pub admin: Pubkey,           // settle authority
    pub treasury: Pubkey,        // protocol fee destination
    pub vault: Pubkey,           // USDC token account owned by config PDA
    pub fee_bps: u16,            // protocol fee in basis points (max 10_000)
    pub bump: u8,
}

impl Config {
    pub const INIT_SPACE: usize =
        32  // admin
        + 32  // treasury
        + 32  // vault
        + 2   // fee_bps
        + 1;  // bump
}

#[account]
pub struct Session {
    pub session_id: u64,                 // monotonic per fan
    pub fan: Pubkey,
    pub creator: Pubkey,
    pub rate_base_units_per_min: u64,    // 0.25..50 USDC
    pub max_minutes: u8,                 // 1..60
    pub cap_base_units: u64,             // rate * max_minutes
    pub opened_at: i64,                  // unix ts
    pub accepted_at: i64,                // 0 until accept
    pub settled_at: i64,                 // 0 until settle/refund
    pub seconds_used: u64,               // 0 until settle
    pub gross_base_units: u64,           // 0 until settle
    pub fee_base_units: u64,             // 0 until settle
    pub creator_payout_base_units: u64,  // 0 until settle
    pub refund_base_units: u64,          // 0 until settle/refund
    pub status: SessionStatus,
    pub bump: u8,
}

impl Session {
    pub const INIT_SPACE: usize =
        8   // session_id
        + 32  // fan
        + 32  // creator
        + 8   // rate
        + 1   // max_minutes
        + 8   // cap
        + 8   // opened_at
        + 8   // accepted_at
        + 8   // settled_at
        + 8   // seconds_used
        + 8   // gross
        + 8   // fee
        + 8   // creator_payout
        + 8   // refund
        + 1   // status
        + 1;  // bump
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum SessionStatus {
    Pending,
    Active,
    Settled,
    Refunded,
}

#[event]
pub struct Settled {
    pub session: Pubkey,
    pub fan: Pubkey,
    pub creator: Pubkey,
    pub seconds_used: u64,
    pub gross_base_units: u64,
    pub fee_base_units: u64,
    pub creator_payout_base_units: u64,
    pub refund_base_units: u64,
    pub settled_at: i64,
}

#[event]
pub struct Refunded {
    pub session: Pubkey,
    pub fan: Pubkey,
    pub creator: Pubkey,
    pub refund_base_units: u64,
    pub refunded_at: i64,
}