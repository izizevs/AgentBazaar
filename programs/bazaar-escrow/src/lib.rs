use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use bazaar_registry::program::BazaarRegistry;
use bazaar_registry::ServiceListing;
use crate::program::BazaarEscrow;

declare_id!("EhFptDs4mz6rt7HDmt8pB7ZogiqxUMVhpjB3NvToXxW2");

pub const MAX_RESULT_URI: usize = 128;
pub const MAX_REASON: usize = 128;
pub const MAX_EVIDENCE_URI: usize = 128;
pub const MAX_SCORE_TAGS: usize = 4;
pub const MAX_TAG_LEN: usize = 16;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum SlaSeverity {
    /// Latency within 10% over max — 100% to seller.
    Minor,
    /// Latency 10–50% over max — 80% to seller / 20% refund to buyer.
    Moderate,
    /// Latency >50% over max — 50/50 split.
    Major,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum EscrowState {
    Created,
    Delivered,
    Confirmed,
    TimeoutClaimed,
    Disputed,
}

#[program]
pub mod bazaar_escrow {
    use super::*;

    /// Buyer transfers USDC to vault PDA and records escrow metadata.
    pub fn create_escrow(
        ctx: Context<CreateEscrow>,
        amount: u64,
        sla_max_latency_ms: Option<u32>,
        sla_response_format: Option<String>,
        deadline_secs: i64,
        nonce: u64,
    ) -> Result<()> {
        require!(amount > 0, EscrowError::ZeroAmount);
        require!(deadline_secs > 0, EscrowError::InvalidDeadline);

        if let Some(fmt) = &sla_response_format {
            require!(fmt.len() <= MAX_RESULT_URI, EscrowError::FieldTooLong);
        }

        let clock = Clock::get()?;
        let deadline_ts = clock
            .unix_timestamp
            .checked_add(deadline_secs)
            .ok_or(EscrowError::ArithmeticOverflow)?;

        let cpi_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.buyer_token_account.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.buyer.to_account_info(),
            },
        );
        token::transfer(cpi_ctx, amount)?;

        let escrow = &mut ctx.accounts.escrow;
        escrow.buyer = ctx.accounts.buyer.key();
        escrow.seller = ctx.accounts.listing.owner;
        escrow.listing = ctx.accounts.listing.key();
        escrow.amount = amount;
        escrow.sla_max_latency_ms = sla_max_latency_ms;
        escrow.sla_response_format = sla_response_format;
        escrow.deadline_ts = deadline_ts;
        escrow.nonce = nonce;
        escrow.state = EscrowState::Created;
        escrow.created_at = clock.unix_timestamp;
        escrow.bump = ctx.bumps.escrow;
        escrow.vault_bump = ctx.bumps.vault;

        emit_cpi!(EscrowCreated {
            escrow: escrow.key(),
            buyer: escrow.buyer,
            seller: escrow.seller,
            listing: escrow.listing,
            amount,
            deadline_ts,
            created_at: escrow.created_at,
        });

        Ok(())
    }

    /// Seller submits delivery URI + hash. Must be before deadline.
    pub fn submit_delivery(
        ctx: Context<SellerAction>,
        result_uri: String,
        result_hash: [u8; 32],
    ) -> Result<()> {
        require!(result_uri.len() <= MAX_RESULT_URI, EscrowError::FieldTooLong);

        let clock = Clock::get()?;
        let escrow = &mut ctx.accounts.escrow;

        require!(
            escrow.state == EscrowState::Created,
            EscrowError::InvalidStateTransition
        );
        require!(
            clock.unix_timestamp <= escrow.deadline_ts,
            EscrowError::DeadlinePassed
        );

        let old = escrow.state;
        escrow.state = EscrowState::Delivered;
        escrow.result_uri = Some(result_uri.clone());
        escrow.result_hash = Some(result_hash);
        escrow.delivered_at = Some(clock.unix_timestamp);

        emit_cpi!(EscrowStateChanged {
            escrow: escrow.key(),
            buyer: escrow.buyer,
            seller: escrow.seller,
            old_state: old,
            new_state: EscrowState::Delivered,
            timestamp: clock.unix_timestamp,
        });
        emit_cpi!(DeliverySubmitted {
            escrow: escrow.key(),
            seller: escrow.seller,
            result_uri,
            result_hash,
            delivered_at: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Buyer confirms delivery. Applies SLA refund logic, releases funds,
    /// increments listing.jobs_completed via CPI to bazaar-registry.
    pub fn confirm_delivery(
        ctx: Context<ConfirmDelivery>,
        score: u8,
        tags: Vec<String>,
    ) -> Result<()> {
        // L1 fix: validate score range
        require!(score <= 100, EscrowError::InvalidScore);
        // L2 fix: validate tags
        require!(tags.len() <= MAX_SCORE_TAGS, EscrowError::TooManyTags);
        for t in &tags {
            require!(t.len() <= MAX_TAG_LEN, EscrowError::FieldTooLong);
        }

        let clock = Clock::get()?;

        require!(
            ctx.accounts.escrow.state == EscrowState::Delivered,
            EscrowError::InvalidStateTransition
        );

        let severity = compute_severity(&ctx.accounts.escrow);

        let seller_bps: u64 = match severity {
            SlaSeverity::Minor => 10_000,
            SlaSeverity::Moderate => 8_000,
            SlaSeverity::Major => 5_000,
        };
        let refund_bps: u64 = 10_000u64
            .checked_sub(seller_bps)
            .ok_or(EscrowError::ArithmeticOverflow)?;

        let amount = ctx.accounts.escrow.amount;
        let seller_amount = amount
            .checked_mul(seller_bps)
            .ok_or(EscrowError::ArithmeticOverflow)?
            .checked_div(10_000)
            .ok_or(EscrowError::ArithmeticOverflow)?;
        let buyer_refund = amount
            .checked_sub(seller_amount)
            .ok_or(EscrowError::ArithmeticOverflow)?;

        let escrow_key = ctx.accounts.escrow.key();
        let vault_bump = ctx.accounts.escrow.vault_bump;
        let vault_seeds: &[&[u8]] = &[b"vault", escrow_key.as_ref(), &[vault_bump]];
        let vault_signer = &[vault_seeds];

        if seller_amount > 0 {
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.seller_token_account.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                vault_signer,
            );
            token::transfer(cpi_ctx, seller_amount)?;
        }

        if buyer_refund > 0 {
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.buyer_token_account.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                vault_signer,
            );
            token::transfer(cpi_ctx, buyer_refund)?;
        }

        // C1 fix: use new_with_signer so the escrow_authority PDA signs the CPI.
        // bazaar-registry verifies the signer is derived from [b"authority"] + bazaar-escrow program ID.
        let authority_bump = ctx.bumps.escrow_authority;
        let authority_seeds: &[&[u8]] = &[b"authority", &[authority_bump]];
        let authority_signer = &[authority_seeds];

        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.registry_program.to_account_info(),
            bazaar_registry::cpi::accounts::IncrementJobsCompleted {
                listing: ctx.accounts.listing.to_account_info(),
                escrow_authority: ctx.accounts.escrow_authority.to_account_info(),
            },
            authority_signer,
        );
        bazaar_registry::cpi::increment_jobs_completed(cpi_ctx)?;

        let escrow = &mut ctx.accounts.escrow;
        let old = escrow.state;
        escrow.state = EscrowState::Confirmed;

        emit_cpi!(EscrowStateChanged {
            escrow: escrow.key(),
            buyer: escrow.buyer,
            seller: escrow.seller,
            old_state: old,
            new_state: EscrowState::Confirmed,
            timestamp: clock.unix_timestamp,
        });
        emit_cpi!(SLAReport {
            escrow: escrow.key(),
            buyer: escrow.buyer,
            seller: escrow.seller,
            severity,
            seller_bps,
            refund_bps,
            score,
            tags,
            confirmed_at: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Seller claims payment after deadline passes with delivery submitted but not confirmed.
    pub fn claim_timeout(ctx: Context<SellerAction>) -> Result<()> {
        let clock = Clock::get()?;

        require!(
            ctx.accounts.escrow.state == EscrowState::Delivered,
            EscrowError::InvalidStateTransition
        );
        require!(
            clock.unix_timestamp > ctx.accounts.escrow.deadline_ts,
            EscrowError::DeadlineNotYetPassed
        );

        let amount = ctx.accounts.escrow.amount;
        let escrow_key = ctx.accounts.escrow.key();
        let vault_bump = ctx.accounts.escrow.vault_bump;
        let vault_seeds: &[&[u8]] = &[b"vault", escrow_key.as_ref(), &[vault_bump]];
        let signer_seeds = &[vault_seeds];

        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.seller_token_account.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(cpi_ctx, amount)?;

        let escrow = &mut ctx.accounts.escrow;
        let old = escrow.state;
        escrow.state = EscrowState::TimeoutClaimed;

        emit_cpi!(EscrowStateChanged {
            escrow: escrow.key(),
            buyer: escrow.buyer,
            seller: escrow.seller,
            old_state: old,
            new_state: EscrowState::TimeoutClaimed,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Buyer opens dispute. M1 stub: full refund to buyer immediately.
    /// V1 will add an arbitration path (see docs/decisions/0002-m1-dispute-stub.md).
    pub fn open_dispute(
        ctx: Context<BuyerAction>,
        reason: String,
        evidence_uri: String,
    ) -> Result<()> {
        require!(reason.len() <= MAX_REASON, EscrowError::FieldTooLong);
        require!(
            evidence_uri.len() <= MAX_EVIDENCE_URI,
            EscrowError::FieldTooLong
        );

        let clock = Clock::get()?;

        require!(
            ctx.accounts.escrow.state == EscrowState::Created
                || ctx.accounts.escrow.state == EscrowState::Delivered,
            EscrowError::InvalidStateTransition
        );

        let amount = ctx.accounts.escrow.amount;
        let escrow_key = ctx.accounts.escrow.key();
        let vault_bump = ctx.accounts.escrow.vault_bump;
        let vault_seeds: &[&[u8]] = &[b"vault", escrow_key.as_ref(), &[vault_bump]];
        let signer_seeds = &[vault_seeds];

        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.buyer_token_account.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(cpi_ctx, amount)?;

        let escrow = &mut ctx.accounts.escrow;
        let old = escrow.state;
        escrow.state = EscrowState::Disputed;

        emit_cpi!(EscrowStateChanged {
            escrow: escrow.key(),
            buyer: escrow.buyer,
            seller: escrow.seller,
            old_state: old,
            new_state: EscrowState::Disputed,
            timestamp: clock.unix_timestamp,
        });
        emit_cpi!(DisputeOpened {
            escrow: escrow.key(),
            buyer: escrow.buyer,
            reason,
            evidence_uri,
            opened_at: clock.unix_timestamp,
        });

        Ok(())
    }
}

// ---------------------------------------------------------------------------
// SLA severity helper
// ---------------------------------------------------------------------------

fn compute_severity(escrow: &EscrowAccount) -> SlaSeverity {
    if let (Some(max_ms), Some(delivered_at)) = (escrow.sla_max_latency_ms, escrow.delivered_at) {
        // M1 fix: clamp to 0 before cast — negative difference (clock anomaly) must not
        // wrap to near-u64::MAX and trigger erroneous Major severity.
        let elapsed_secs = delivered_at.saturating_sub(escrow.created_at).max(0);
        let actual_ms = (elapsed_secs as u64).saturating_mul(1_000);
        let max_ms = max_ms as u64;
        if actual_ms <= max_ms.saturating_add(max_ms / 10) {
            SlaSeverity::Minor
        } else if actual_ms <= max_ms.saturating_add(max_ms / 2) {
            SlaSeverity::Moderate
        } else {
            SlaSeverity::Major
        }
    } else {
        SlaSeverity::Minor
    }
}

// ---------------------------------------------------------------------------
// Account contexts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(amount: u64, sla_max_latency_ms: Option<u32>, sla_response_format: Option<String>, deadline_secs: i64, nonce: u64)]
pub struct CreateEscrow<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    pub listing: Account<'info, ServiceListing>,

    #[account(
        init,
        payer = buyer,
        space = 8 + EscrowAccount::INIT_SPACE,
        seeds = [b"escrow", buyer.key().as_ref(), listing.key().as_ref(), &nonce.to_le_bytes()],
        bump,
    )]
    pub escrow: Account<'info, EscrowAccount>,

    #[account(
        init,
        payer = buyer,
        token::mint = usdc_mint,
        token::authority = vault,
        seeds = [b"vault", escrow.key().as_ref()],
        bump,
    )]
    pub vault: Account<'info, TokenAccount>,

    // H2 fix: enforce buyer_token_account uses the same mint as the vault.
    #[account(
        mut,
        token::mint = usdc_mint,
        token::authority = buyer,
    )]
    pub buyer_token_account: Account<'info, TokenAccount>,

    /// CHECK: USDC mint — validated transitively via token::mint constraints on vault
    /// and buyer_token_account. H1 per-cluster address check is M1-tail work
    /// (see docs/decisions/0002-m1-dispute-stub.md for why devnet omits it).
    pub usdc_mint: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    // I3 note: Anchor 0.31 handles rent implicitly for token account init;
    // retained here for backward compat with existing test call sites.
    pub rent: Sysvar<'info, Rent>,

    /// CHECK: Anchor event authority PDA for emit_cpi.
    #[account(seeds = [b"__event_authority"], bump)]
    pub event_authority: AccountInfo<'info>,
    pub program: Program<'info, BazaarEscrow>,
}

#[derive(Accounts)]
pub struct SellerAction<'info> {
    pub seller: Signer<'info>,

    #[account(
        mut,
        has_one = seller @ EscrowError::Unauthorized,
        seeds = [b"escrow", escrow.buyer.as_ref(), escrow.listing.as_ref(), &escrow.nonce.to_le_bytes()],
        bump = escrow.bump,
    )]
    pub escrow: Account<'info, EscrowAccount>,

    #[account(
        mut,
        seeds = [b"vault", escrow.key().as_ref()],
        bump = escrow.vault_bump,
    )]
    pub vault: Account<'info, TokenAccount>,

    // C2+H2 fix: enforce mint match and owner is the escrow's recorded seller.
    #[account(
        mut,
        token::mint = vault.mint,
        token::authority = escrow.seller,
    )]
    pub seller_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,

    /// CHECK: Anchor event authority PDA for emit_cpi.
    #[account(seeds = [b"__event_authority"], bump)]
    pub event_authority: AccountInfo<'info>,
    pub program: Program<'info, BazaarEscrow>,
}

#[derive(Accounts)]
pub struct BuyerAction<'info> {
    pub buyer: Signer<'info>,

    #[account(
        mut,
        has_one = buyer @ EscrowError::Unauthorized,
        seeds = [b"escrow", escrow.buyer.as_ref(), escrow.listing.as_ref(), &escrow.nonce.to_le_bytes()],
        bump = escrow.bump,
    )]
    pub escrow: Account<'info, EscrowAccount>,

    #[account(
        mut,
        seeds = [b"vault", escrow.key().as_ref()],
        bump = escrow.vault_bump,
    )]
    pub vault: Account<'info, TokenAccount>,

    // C2+H2 fix: enforce mint match and owner is the escrow's recorded buyer.
    #[account(
        mut,
        token::mint = vault.mint,
        token::authority = escrow.buyer,
    )]
    pub buyer_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,

    /// CHECK: Anchor event authority PDA for emit_cpi.
    #[account(seeds = [b"__event_authority"], bump)]
    pub event_authority: AccountInfo<'info>,
    pub program: Program<'info, BazaarEscrow>,
}

#[derive(Accounts)]
pub struct ConfirmDelivery<'info> {
    pub buyer: Signer<'info>,

    #[account(
        mut,
        has_one = buyer @ EscrowError::Unauthorized,
        seeds = [b"escrow", escrow.buyer.as_ref(), escrow.listing.as_ref(), &escrow.nonce.to_le_bytes()],
        bump = escrow.bump,
    )]
    pub escrow: Account<'info, EscrowAccount>,

    #[account(
        mut,
        seeds = [b"vault", escrow.key().as_ref()],
        bump = escrow.vault_bump,
    )]
    pub vault: Account<'info, TokenAccount>,

    // C2+H2 fix: seller_token_account must be owned by the recorded seller
    // and share the vault's mint — prevents buyer from redirecting the payout.
    #[account(
        mut,
        token::mint = vault.mint,
        token::authority = escrow.seller,
    )]
    pub seller_token_account: Account<'info, TokenAccount>,

    // H2 fix: buyer refund account must also match vault mint and be buyer-owned.
    #[account(
        mut,
        token::mint = vault.mint,
        token::authority = escrow.buyer,
    )]
    pub buyer_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = listing.key() == escrow.listing @ EscrowError::ListingMismatch,
    )]
    pub listing: Account<'info, ServiceListing>,

    pub registry_program: Program<'info, BazaarRegistry>,

    /// C1 fix: authority PDA for signing the registry CPI.
    /// Derived from [b"authority"] in this program; bazaar-registry verifies
    /// it was signed by the bazaar-escrow program via seeds::program constraint.
    /// CHECK: PDA address verified by seeds constraint; signing done via new_with_signer.
    #[account(
        seeds = [b"authority"],
        bump,
    )]
    pub escrow_authority: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,

    /// CHECK: Anchor event authority PDA for emit_cpi.
    #[account(seeds = [b"__event_authority"], bump)]
    pub event_authority: AccountInfo<'info>,
    pub program: Program<'info, BazaarEscrow>,
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct EscrowAccount {
    pub buyer: Pubkey,
    pub seller: Pubkey,
    pub listing: Pubkey,
    pub amount: u64,
    pub sla_max_latency_ms: Option<u32>,
    #[max_len(MAX_RESULT_URI)]
    pub sla_response_format: Option<String>,
    pub deadline_ts: i64,
    pub nonce: u64,
    pub state: EscrowState,
    pub created_at: i64,
    pub delivered_at: Option<i64>,
    #[max_len(MAX_RESULT_URI)]
    pub result_uri: Option<String>,
    pub result_hash: Option<[u8; 32]>,
    pub bump: u8,
    pub vault_bump: u8,
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[event]
pub struct EscrowCreated {
    pub escrow: Pubkey,
    pub buyer: Pubkey,
    pub seller: Pubkey,
    pub listing: Pubkey,
    pub amount: u64,
    pub deadline_ts: i64,
    pub created_at: i64,
}

// L3 fix: include buyer + seller so indexer can update rows without re-reading PDA.
#[event]
pub struct EscrowStateChanged {
    pub escrow: Pubkey,
    pub buyer: Pubkey,
    pub seller: Pubkey,
    pub old_state: EscrowState,
    pub new_state: EscrowState,
    pub timestamp: i64,
}

#[event]
pub struct DeliverySubmitted {
    pub escrow: Pubkey,
    pub seller: Pubkey,
    pub result_uri: String,
    pub result_hash: [u8; 32],
    pub delivered_at: i64,
}

// L3 fix: include buyer + seller + tags for complete indexer row.
#[event]
pub struct SLAReport {
    pub escrow: Pubkey,
    pub buyer: Pubkey,
    pub seller: Pubkey,
    pub severity: SlaSeverity,
    pub seller_bps: u64,
    pub refund_bps: u64,
    pub score: u8,
    pub tags: Vec<String>,
    pub confirmed_at: i64,
}

#[event]
pub struct DisputeOpened {
    pub escrow: Pubkey,
    pub buyer: Pubkey,
    pub reason: String,
    pub evidence_uri: String,
    pub opened_at: i64,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[error_code]
pub enum EscrowError {
    #[msg("Only the authorized party can perform this action")]
    Unauthorized,
    #[msg("Escrow amount must be greater than zero")]
    ZeroAmount,
    #[msg("Invalid deadline — must be positive seconds from now")]
    InvalidDeadline,
    #[msg("String field exceeds maximum length")]
    FieldTooLong,
    #[msg("Invalid state transition for current escrow state")]
    InvalidStateTransition,
    #[msg("Delivery deadline has already passed")]
    DeadlinePassed,
    #[msg("Deadline has not yet passed — cannot claim timeout")]
    DeadlineNotYetPassed,
    #[msg("Listing account does not match escrow record")]
    ListingMismatch,
    #[msg("Too many score tags")]
    TooManyTags,
    #[msg("Arithmetic overflow in amount calculation")]
    ArithmeticOverflow,
    #[msg("Score must be in range 0–100")]
    InvalidScore,
}
