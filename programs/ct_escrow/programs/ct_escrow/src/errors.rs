use anchor_lang::prelude::*;

#[error_code]
pub enum EscrowError {
    #[msg("fee_bps must be in 0..=10000")]
    InvalidFeeBps,
    #[msg("rate is 0 or above 50 USDC a minute")]
    InvalidRate,
    #[msg("max_minutes must be > 0")]
    InvalidMinutes,
    #[msg("Math overflow in escrow math")]
    MathOverflow,
    #[msg("Session is not in the Open state")]
    NotOpen,
    #[msg("Session is already closed")]
    AlreadyClosed,
    #[msg("Caller is not authorized (settle_authority or fan)")]
    Unauthorized,
    #[msg("Too early to refund (accept window not expired)")]
    TooEarlyForRefund,
    #[msg("Vault token account mint does not match expected USDC")]
    InvalidMint,
    #[msg("Vault token account owner is not the config PDA")]
    InvalidVaultOwner,
    #[msg("Token account owner is not the expected signer")]
    InvalidTokenOwner,
    #[msg("Clock math failed")]
    ClockMath,
    #[msg("The accept window has expired")]
    AcceptWindowExpired,
}