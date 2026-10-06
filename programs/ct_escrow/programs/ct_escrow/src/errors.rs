// Error codes for ct_escrow. The errors are mapped to contract
// error codes in `contract/idl/ct_escrow.errors.json` so the
// backend can surface them as the right envelope.

use anchor_lang::prelude::*;

#[error_code]
pub enum EscrowError {
    #[msg("fee_bps must be in 0..=10_000")]
    InvalidFeeBps,

    #[msg("rate must be in [MIN_RATE_BASE_UNITS, MAX_RATE_BASE_UNITS]")]
    InvalidRate,

    #[msg("max_minutes must be in [MIN_MINUTES, MAX_MINUTES]")]
    InvalidMinutes,

    #[msg("Math overflow in escrow math")]
    MathOverflow,

    #[msg("Session is not pending")]
    NotPending,

    #[msg("Session is not active")]
    NotActive,

    #[msg("Caller is not the session creator")]
    NotCreator,

    #[msg("Caller is not the session fan")]
    NotFan,

    #[msg("Accept window has expired; fan can refund")]
    AcceptWindowExpired,

    #[msg("Already settled")]
    AlreadySettled,

    #[msg("Cannot refund (active session within grace window)")]
    CannotRefund,

    #[msg("Vault token account mint does not match expected USDC")]
    InvalidMint,

    #[msg("Vault token account owner is not the config PDA")]
    InvalidVaultOwner,

    #[msg("Provided vault does not match config.vault")]
    InvalidVault,

    #[msg("Token account owner is not the expected signer")]
    InvalidTokenOwner,

    #[msg("Clock math failed")]
    ClockMath,
}