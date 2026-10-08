// =============================================================================
// CT Life paid-call escrow program (M4 / spec section 6).
//
// Accounts
//   • Config PDA, seeds ["config"]
//       admin, settle_authority, treasury (USDC account), usdc_mint,
//       fee_bps (u16, default 1000), accept_window_secs (u32, 120).
//   • Session PDA, seeds ["session", fan, creator, session_id_le_bytes]
//       fan, creator, session_id: u64, rate_per_min: u64, max_minutes: u16,
//       deposit: u64 (rate × max_minutes × (1 + fee_bps/10000) at open),
//       fee_bps: u16 (copied from Config at open),
//       opened_at: i64, accepted_at: i64 (0 until accept),
//       status: u8 (0 Open, 1 Accepted, 2 Settled, 3 Refunded), bump.
//   • Vault: the Session PDA's USDC associated token account.
//
// Instructions
//   init_config(fee_bps, accept_window_secs)  admin
//   open_session(session_id, rate_per_min, max_minutes)  fan
//     Moves rate × max_minutes × (1 + fee_bps/10000) from fan to vault.
//   accept()  settle_authority
//   settle(seconds_used)  settle_authority
//     minutes = ceil(seconds/60), capped at max. Pays creator rate × min,
//     pays treasury rate × min × fee_bps / 10000, refunds remainder to
//     fan, closes vault + Session (rent → fan).
//   refund()  fan or settle_authority
//     Open + accept window expired, or Accepted + max_minutes*60+600s
//     since opened_at.
//
// Errors (spec): InvalidRate (rate is 0 or > 50 USDC/min),
//   TooEarlyForRefund, AlreadyClosed, Unauthorized, MathOverflow.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer, CloseAccount};
use anchor_spl::associated_token::AssociatedToken;

declare_id!("FKvuRNUxGgijeD8P4varsnzBiLduCWKMhSLQp5fQsMfz");

pub mod errors;
pub use errors::EscrowError;

pub const FEE_BPS_DENOM: u64 = 10_000;
/// Spec default: 10% platform fee.
pub const DEFAULT_FEE_BPS: u16 = 1_000;
/// Spec default: 120 s accept window.
pub const DEFAULT_ACCEPT_WINDOW_SECS: u32 = 120;
/// Spec: refund allowed after `max_minutes × 60 + 600 s` post-accept.
pub const POST_ACCEPT_GRACE_SECS: i64 = 600;
/// Program-side rate validation is only a positive rate <= 50 USDC/min.
/// The 0.25 USDC/min floor is enforced by the API layer, not here.
pub const MIN_RATE_BASE_UNITS: u64 = 1;
pub const MAX_RATE_BASE_UNITS: u64 = 50_000_000;
/// Spec: u16 minutes.
pub const MAX_MINUTES: u16 = u16::MAX;

#[program]
pub mod ct_escrow {
    use super::*;

    /// One-time setup. The admin is the backend's settle
    /// authority. Fee 1000 bps = 10% per spec.
    pub fn init_config(
        ctx: Context<InitConfig>,
        fee_bps: u16,
        accept_window_secs: u32,
    ) -> Result<()> {
        require!(
            fee_bps <= FEE_BPS_DENOM as u16,
            EscrowError::InvalidFeeBps
        );
        let cfg = &mut ctx.accounts.config;
        cfg.admin = ctx.accounts.admin.key();
        cfg.settle_authority = ctx.accounts.settle_authority.key();
        cfg.treasury = ctx.accounts.treasury.key();
        cfg.usdc_mint = ctx.accounts.usdc_mint.key();
        cfg.vault = ctx.accounts.vault.key();
        cfg.fee_bps = fee_bps;
        cfg.accept_window_secs = accept_window_secs;
        cfg.bump = ctx.bumps.config;
        emit!(ConfigInitialized {
            admin: cfg.admin,
            settle_authority: cfg.settle_authority,
            treasury: cfg.treasury,
            fee_bps: cfg.fee_bps,
            accept_window_secs: cfg.accept_window_secs,
        });
        Ok(())
    }

    /// Fan opens the session. The on-chain deposit is
    /// `rate × max_minutes × (1 + fee_bps/10000)` — the creator's
    /// eventual payout, the fee, and the rent all come from this
    /// single deposit. The vault is the Session PDA's USDC ATA.
    pub fn open_session(
        ctx: Context<OpenSession>,
        session_id: u64,
        rate_per_min: u64,
        max_minutes: u16,
    ) -> Result<()> {
        require!(
            rate_per_min > 0 && rate_per_min <= MAX_RATE_BASE_UNITS,
            EscrowError::InvalidRate
        );
        require!(max_minutes > 0 && max_minutes <= 60, EscrowError::InvalidMinutes);
        let cfg = &ctx.accounts.config;
        let deposit: u64 = (rate_per_min as u128)
            .checked_mul(max_minutes as u128)
            .and_then(|s| s.checked_mul((FEE_BPS_DENOM as u128) + (cfg.fee_bps as u128)))
            .and_then(|s| s.checked_div(FEE_BPS_DENOM as u128))
            .and_then(|s| u64::try_from(s).ok())
            .ok_or(EscrowError::MathOverflow)?;

        // Initialize the Session PDA.
        let session = &mut ctx.accounts.session;
        session.session_id = session_id;
        session.fan = ctx.accounts.fan.key();
        session.creator = ctx.accounts.creator.key();
        session.rate_per_min = rate_per_min;
        session.max_minutes = max_minutes;
        session.deposit = deposit;
        session.fee_bps = cfg.fee_bps;
        session.opened_at = Clock::get()?.unix_timestamp;
        session.accepted_at = 0;
        session.settled_at = 0;
        session.status = 0; // Open
        session.bump = ctx.bumps.session;

        // The vault is the Session PDA's USDC ATA. Create it
        // here; the user signed for fan, the PDA authorizes the
        // ATA create via `init_if_needed` (CPI to Associated
        // Token Program; the fan funds the ATA after creation).
        // We split the deposit transfer out so the init runs
        // first; token::transfer is below.

        let cpi_accounts = Transfer {
            from: ctx.accounts.fan_usdc_ata.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
            authority: ctx.accounts.fan.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        token::transfer(cpi_ctx, deposit)?;

        let event = SessionOpened {
            session: ctx.accounts.session.key(),
            fan: ctx.accounts.session.fan,
            creator: ctx.accounts.session.creator,
            session_id,
            rate_per_min,
            max_minutes,
            deposit,
            fee_bps: ctx.accounts.session.fee_bps,
            opened_at: ctx.accounts.session.opened_at,
        };
        emit!(event);
        Ok(())
    }

    /// Settle authority marks the session Accepted. This
    /// happens after the creator taps Accept in the client.
    pub fn accept(ctx: Context<Accept>) -> Result<()> {
        let cfg = &ctx.accounts.config;
        let session = &mut ctx.accounts.session;
        require!(session.status == 0, EscrowError::AlreadyClosed);
        require!(
            ctx.accounts.settle_authority.key() == cfg.settle_authority,
            EscrowError::Unauthorized
        );
        let now = Clock::get()?.unix_timestamp;
        require!(
            now <= session.opened_at + cfg.accept_window_secs as i64,
            EscrowError::AcceptWindowExpired
        );
        session.status = 1; // Accepted
        session.accepted_at = now;
        let event = SessionAccepted {
            session: ctx.accounts.session.key(),
            accepted_at: now,
        };
        emit!(event);
        Ok(())
    }

    /// Settle authority closes the call.
    ///   minutes = ceil(seconds/60), capped at max_minutes.
    ///   gross   = rate × minutes
    ///   fee     = floor(gross × fee_bps / 10000)
    ///   creator = gross
    ///   fan     = vault.amount - gross - fee
    ///   The vault and Session accounts are closed after the
    ///   payouts; the rent-exempt balance that the program
    ///   held for the Session is returned to the fan.
    pub fn settle(ctx: Context<Settle>, seconds_used: u64) -> Result<()> {
        let cfg = &ctx.accounts.config;
        let session = &mut ctx.accounts.session;
        require!(session.status == 1, EscrowError::AlreadyClosed);
        require!(
            ctx.accounts.settle_authority.key() == cfg.settle_authority,
            EscrowError::Unauthorized
        );

        let now = Clock::get()?.unix_timestamp;
        let max_secs = (session.max_minutes as i64)
            .checked_mul(60)
            .ok_or(EscrowError::MathOverflow)?;
        let seconds_used = (seconds_used as i64).min(max_secs);
        let minutes: u64 = {
            let s = seconds_used as u64;
            ((s + 59) / 60).min(session.max_minutes as u64)
        };
        let gross: u64 = (session.rate_per_min as u128)
            .checked_mul(minutes as u128)
            .and_then(|s| u64::try_from(s).ok())
            .ok_or(EscrowError::MathOverflow)?;
        let fee: u64 = (gross as u128)
            .checked_mul(session.fee_bps as u128)
            .and_then(|s| s.checked_div(FEE_BPS_DENOM as u128))
            .and_then(|s| u64::try_from(s).ok())
            .ok_or(EscrowError::MathOverflow)?;

        let vault_amount = ctx.accounts.vault.amount;
        let total_owed = gross
            .checked_add(fee)
            .ok_or(EscrowError::MathOverflow)?;
        if vault_amount < total_owed {
            return err!(EscrowError::MathOverflow);
        }
        let fan_refund = vault_amount
            .checked_sub(total_owed)
            .ok_or(EscrowError::MathOverflow)?;

        session.status = 2; // Settled
        session.settled_at = now;

        let session_seeds: &[&[u8]] = &[
            b"session",
            session.fan.as_ref(),
            session.creator.as_ref(),
            &session.session_id.to_le_bytes(),
            &[session.bump],
        ];
        let signer = &[&session_seeds[..]];

        if gross > 0 {
            let cpi_accounts = Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.creator_usdc_ata.to_account_info(),
                authority: session.to_account_info(),
            };
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                cpi_accounts,
                signer,
            );
            token::transfer(cpi_ctx, gross)?;
        }
        if fee > 0 {
            let cpi_accounts = Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.treasury_usdc_ata.to_account_info(),
                authority: session.to_account_info(),
            };
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                cpi_accounts,
                signer,
            );
            token::transfer(cpi_ctx, fee)?;
        }
        if fan_refund > 0 {
            let cpi_accounts = Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.fan_usdc_ata.to_account_info(),
                authority: session.to_account_info(),
            };
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                cpi_accounts,
                signer,
            );
            token::transfer(cpi_ctx, fan_refund)?;
        }

        // The vault may have dust; we pay from the actual vault balance and
        // floor the fee using integer division, so the fan gets the remainder.
        let close_accounts = CloseAccount {
            account: ctx.accounts.vault.to_account_info(),
            destination: ctx.accounts.fan.to_account_info(),
            authority: session.to_account_info(),
        };
        let close_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            close_accounts,
            signer,
        );
        token::close_account(close_ctx)?;

        let event = SessionSettled {
            session: ctx.accounts.session.key(),
            minutes,
            creator_amount: gross,
            fee,
            refund: fan_refund,
        };
        emit!(event);
        Ok(())
    }

    /// Fan or settle authority refunds. Allowed:
    ///   - Status Open + now > opened_at + accept_window_secs
    ///     (creator never accepted).
    ///   - Status Accepted + now > opened_at + max_minutes × 60 + 600 s.
    pub fn refund(ctx: Context<Refund>) -> Result<()> {
        let cfg = &ctx.accounts.config;
        let session = &mut ctx.accounts.session;
        let now = Clock::get()?.unix_timestamp;
        let allowed = match session.status {
            0 => now > session.opened_at + cfg.accept_window_secs as i64,
            1 => {
                let max_deadline = session
                    .opened_at
                    .checked_add((session.max_minutes as i64).checked_mul(60).ok_or(EscrowError::MathOverflow)?)
                    .and_then(|ts| ts.checked_add(POST_ACCEPT_GRACE_SECS))
                    .ok_or(EscrowError::MathOverflow)?;
                now > max_deadline
            }
            _ => false,
        };
        if !allowed {
            return err!(EscrowError::TooEarlyForRefund);
        }
        require!(
            ctx.accounts.signer.key() == session.fan || ctx.accounts.signer.key() == cfg.settle_authority,
            EscrowError::Unauthorized
        );

        session.status = 3; // Refunded
        session.settled_at = now;

        let refund_amount = ctx.accounts.vault.amount;
        let session_seeds: &[&[u8]] = &[
            b"session",
            session.fan.as_ref(),
            session.creator.as_ref(),
            &session.session_id.to_le_bytes(),
            &[session.bump],
        ];
        let signer = &[&session_seeds[..]];
        if refund_amount > 0 {
            let cpi_accounts = Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.fan_usdc_ata.to_account_info(),
                authority: session.to_account_info(),
            };
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                cpi_accounts,
                signer,
            );
            token::transfer(cpi_ctx, refund_amount)?;
        }

        let close_accounts = CloseAccount {
            account: ctx.accounts.vault.to_account_info(),
            destination: ctx.accounts.fan.to_account_info(),
            authority: session.to_account_info(),
        };
        let close_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            close_accounts,
            signer,
        );
        token::close_account(close_ctx)?;

        let event = SessionRefunded {
            session: ctx.accounts.session.key(),
            fan: ctx.accounts.session.fan,
            creator: ctx.accounts.session.creator,
            refund_amount,
        };
        emit!(event);
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
    pub config: Box<Account<'info, Config>>,

    /// CHECK: the USDC token account that holds the vault.
    /// Verified by mint + owner.
    #[account(
        constraint = vault.mint == usdc_mint.key() @ EscrowError::InvalidMint,
        constraint = vault.owner == config.key() @ EscrowError::InvalidVaultOwner,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    pub usdc_mint: Account<'info, anchor_spl::token::Mint>,
    /// CHECK: USDC ATA owned by `treasury`.
    pub treasury: AccountInfo<'info>,

    #[account(mut)]
    pub admin: Signer<'info>,

    /// The settle authority (backend signer). Stored in Config
    /// and required by `accept` / `settle` / `refund`.
    pub settle_authority: Signer<'info>,

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
        seeds = [b"session", fan.key().as_ref(), creator.key().as_ref(), &session_id.to_le_bytes()],
        bump,
    )]
    pub session: Box<Account<'info, Session>>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    /// The vault is the Session PDA's USDC ATA. Created via
    /// `init_if_needed` so the same instruction opens both.
    #[account(
        init_if_needed,
        payer = fan,
        associated_token::mint = usdc_mint,
        associated_token::authority = session,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    #[account(address = config.usdc_mint @ EscrowError::InvalidMint)]
    pub usdc_mint: Box<Account<'info, anchor_spl::token::Mint>>,

    #[account(
        mut,
        constraint = fan_usdc_ata.mint == usdc_mint.key() @ EscrowError::InvalidMint,
        constraint = fan_usdc_ata.owner == fan.key() @ EscrowError::InvalidTokenOwner,
    )]
    pub fan_usdc_ata: Box<Account<'info, TokenAccount>>,

    /// CHECK: the creator whose address seeds the Session PDA.
    pub creator: AccountInfo<'info>,

    #[account(mut)]
    pub fan: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Accept<'info> {
    #[account(
        mut,
        seeds = [b"session", session.fan.as_ref(), session.creator.as_ref(), &session.session_id.to_le_bytes()],
        bump = session.bump,
    )]
    pub session: Box<Account<'info, Session>>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    pub settle_authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(
        mut,
        close = fan,
        seeds = [b"session", session.fan.as_ref(), session.creator.as_ref(), &session.session_id.to_le_bytes()],
        bump = session.bump,
    )]
    pub session: Box<Account<'info, Session>>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = session,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    #[account(address = config.usdc_mint @ EscrowError::InvalidMint)]
    pub usdc_mint: Box<Account<'info, anchor_spl::token::Mint>>,

    #[account(
        mut,
        constraint = creator_usdc_ata.mint == usdc_mint.key() @ EscrowError::InvalidMint,
        constraint = creator_usdc_ata.owner == session.creator @ EscrowError::InvalidTokenOwner,
    )]
    pub creator_usdc_ata: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = fan_usdc_ata.mint == usdc_mint.key() @ EscrowError::InvalidMint,
        constraint = fan_usdc_ata.owner == session.fan @ EscrowError::InvalidTokenOwner,
    )]
    pub fan_usdc_ata: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = treasury_usdc_ata.mint == usdc_mint.key() @ EscrowError::InvalidMint,
        constraint = treasury_usdc_ata.owner == config.treasury @ EscrowError::InvalidTokenOwner,
    )]
    pub treasury_usdc_ata: Box<Account<'info, TokenAccount>>,

    /// The settle authority (must equal config.settle_authority).
    pub settle_authority: Signer<'info>,

    /// CHECK: receives the Session account rent on close.
    #[account(mut, address = session.fan @ EscrowError::Unauthorized)]
    pub fan: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Refund<'info> {
    #[account(
        mut,
        close = fan,
        seeds = [b"session", session.fan.as_ref(), session.creator.as_ref(), &session.session_id.to_le_bytes()],
        bump = session.bump,
    )]
    pub session: Box<Account<'info, Session>>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = session,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    #[account(address = config.usdc_mint @ EscrowError::InvalidMint)]
    pub usdc_mint: Box<Account<'info, anchor_spl::token::Mint>>,

    #[account(
        mut,
        constraint = fan_usdc_ata.mint == usdc_mint.key() @ EscrowError::InvalidMint,
        constraint = fan_usdc_ata.owner == session.fan @ EscrowError::InvalidTokenOwner,
    )]
    pub fan_usdc_ata: Box<Account<'info, TokenAccount>>,

    /// The signer — fan or settle_authority.
    pub signer: Signer<'info>,

    /// CHECK: receives the Session account rent on close.
    #[account(mut, address = session.fan @ EscrowError::Unauthorized)]
    pub fan: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,
}

#[account]
pub struct Config {
    pub admin: Pubkey,
    pub settle_authority: Pubkey,
    pub treasury: Pubkey,
    pub usdc_mint: Pubkey,
    pub vault: Pubkey,
    pub fee_bps: u16,
    pub accept_window_secs: u32,
    pub bump: u8,
}

impl Config {
    pub const INIT_SPACE: usize = 32 + 32 + 32 + 32 + 32 + 2 + 4 + 1;
}

#[account]
pub struct Session {
    pub session_id: u64,
    pub fan: Pubkey,
    pub creator: Pubkey,
    pub rate_per_min: u64,
    pub max_minutes: u16,
    pub deposit: u64,
    pub fee_bps: u16,
    pub opened_at: i64,
    pub accepted_at: i64,
    pub settled_at: i64,
    pub status: u8, // 0 Open, 1 Accepted, 2 Settled, 3 Refunded
    pub bump: u8,
    pub vault_bump: u8,
}

impl Session {
    pub const INIT_SPACE: usize =
        8 + 32 + 32 + 8 + 2 + 8 + 2 + 8 + 8 + 8 + 1 + 1 + 1;
}

#[event]
pub struct ConfigInitialized {
    pub admin: Pubkey,
    pub settle_authority: Pubkey,
    pub treasury: Pubkey,
    pub fee_bps: u16,
    pub accept_window_secs: u32,
}

#[event]
pub struct SessionOpened {
    pub session: Pubkey,
    pub fan: Pubkey,
    pub creator: Pubkey,
    pub session_id: u64,
    pub rate_per_min: u64,
    pub max_minutes: u16,
    pub deposit: u64,
    pub fee_bps: u16,
    pub opened_at: i64,
}

#[event]
pub struct SessionAccepted {
    pub session: Pubkey,
    pub accepted_at: i64,
}

#[event]
pub struct SessionSettled {
    pub session: Pubkey,
    pub minutes: u64,
    pub creator_amount: u64,
    pub fee: u64,
    pub refund: u64,
}

#[event]
pub struct SessionRefunded {
    pub session: Pubkey,
    pub fan: Pubkey,
    pub creator: Pubkey,
    pub refund_amount: u64,
}