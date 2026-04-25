use anchor_lang::prelude::*;
use anchor_lang::solana_program::pubkey;

declare_id!("GJRgCCqkYvAezidpdd3i4p4kRRfJnM1EfGfgqYgchQqd");

pub const MAX_METADATA_URI: usize = 64;
pub const MAX_RESPONSE_FORMAT: usize = 16;
pub const MAX_JSON_SCHEMA_URI: usize = 64;
pub const MAX_CUSTOM_PARAM_KEY: usize = 16;
pub const MAX_CUSTOM_PARAM_VAL: usize = 32;
pub const MAX_CUSTOM_PARAMS: usize = 2;

pub const PRICING_MODEL_MAX: u8 = 3;
pub const UPTIME_PCT_MAX_BPS: u16 = 10_000;

// C1 fix: bazaar-escrow program ID stored as a constant so we can verify
// that increment_jobs_completed is only callable via bazaar-escrow CPI.
// Must stay in sync with declare_id! in programs/bazaar-escrow/src/lib.rs.
pub const BAZAAR_ESCROW_ID: Pubkey = pubkey!("qTezZXasYhw2mUQiJC4FSpu1FrDWqawAWdAaWzvdzSs");

#[program]
pub mod bazaar_registry {
    use super::*;

    pub fn register_service(
        ctx: Context<RegisterService>,
        capability_hash: [u8; 32],
        sati_agent_id: u64,
        price_lamports: u64,
        pricing_model: u8,
        sla_params: SlaParams,
        metadata_uri: String,
    ) -> Result<()> {
        require!(
            capability_hash != [0u8; 32],
            RegistryError::InvalidCapabilityHash
        );
        require!(
            pricing_model <= PRICING_MODEL_MAX,
            RegistryError::InvalidPricingModel
        );
        require!(
            metadata_uri.len() <= MAX_METADATA_URI,
            RegistryError::MetadataUriTooLong
        );
        sla_params.validate()?;

        let clock = Clock::get()?;
        let listing = &mut ctx.accounts.listing;

        listing.owner = ctx.accounts.owner.key();
        listing.sati_agent_id = sati_agent_id;
        listing.capability_hash = capability_hash;
        listing.price_lamports = price_lamports;
        listing.pricing_model = pricing_model;
        listing.sla_params = sla_params;
        listing.metadata_uri = metadata_uri.clone();
        listing.is_active = true;
        listing.jobs_completed = 0;
        listing.created_at = clock.unix_timestamp;
        listing.bump = ctx.bumps.listing;

        emit!(ServiceListingCreated {
            listing: listing.key(),
            owner: listing.owner,
            sati_agent_id,
            capability_hash,
            price_lamports,
            pricing_model,
            metadata_uri,
            created_at: listing.created_at,
        });
        Ok(())
    }

    pub fn update_service(
        ctx: Context<UpdateService>,
        new_price: Option<u64>,
        new_sla: Option<SlaParams>,
        new_uri: Option<String>,
    ) -> Result<()> {
        let clock = Clock::get()?;
        let listing = &mut ctx.accounts.listing;

        if let Some(price) = new_price {
            listing.price_lamports = price;
        }
        if let Some(sla) = new_sla {
            sla.validate()?;
            listing.sla_params = sla;
        }
        if let Some(uri) = new_uri.as_ref() {
            require!(
                uri.len() <= MAX_METADATA_URI,
                RegistryError::MetadataUriTooLong
            );
            listing.metadata_uri = uri.clone();
        }

        emit!(ServiceListingUpdated {
            listing: listing.key(),
            owner: listing.owner,
            new_price,
            new_uri,
            is_active: listing.is_active,
            updated_at: clock.unix_timestamp,
        });
        Ok(())
    }

    pub fn deactivate_service(ctx: Context<ToggleService>) -> Result<()> {
        let clock = Clock::get()?;
        let listing = &mut ctx.accounts.listing;
        require!(listing.is_active, RegistryError::AlreadyInactive);
        listing.is_active = false;

        emit!(ServiceListingUpdated {
            listing: listing.key(),
            owner: listing.owner,
            new_price: None,
            new_uri: None,
            is_active: false,
            updated_at: clock.unix_timestamp,
        });
        Ok(())
    }

    pub fn reactivate_service(ctx: Context<ToggleService>) -> Result<()> {
        let clock = Clock::get()?;
        let listing = &mut ctx.accounts.listing;
        require!(!listing.is_active, RegistryError::AlreadyActive);
        listing.is_active = true;

        emit!(ServiceListingUpdated {
            listing: listing.key(),
            owner: listing.owner,
            new_price: None,
            new_uri: None,
            is_active: true,
            updated_at: clock.unix_timestamp,
        });
        Ok(())
    }

    /// CPI-only: called by bazaar-escrow on confirm_delivery.
    /// The escrow_authority PDA (seeds=[b"authority"], program=bazaar-escrow)
    /// must sign — enforced by the Signer + seeds::program constraint below.
    pub fn increment_jobs_completed(ctx: Context<IncrementJobsCompleted>) -> Result<()> {
        let listing = &mut ctx.accounts.listing;
        listing.jobs_completed = listing
            .jobs_completed
            .checked_add(1)
            .ok_or(RegistryError::JobsCompletedOverflow)?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct IncrementJobsCompleted<'info> {
    #[account(mut)]
    pub listing: Account<'info, ServiceListing>,

    /// C1 fix: PDA derived from [b"authority"] in bazaar-escrow program.
    /// Only bazaar-escrow can produce a valid signer here via CPI invoke_signed.
    #[account(
        seeds = [b"authority"],
        seeds::program = BAZAAR_ESCROW_ID,
        bump,
    )]
    pub escrow_authority: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(capability_hash: [u8; 32])]
pub struct RegisterService<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        init,
        payer = owner,
        space = 8 + ServiceListing::INIT_SPACE,
        seeds = [b"listing", owner.key().as_ref(), capability_hash.as_ref()],
        bump,
    )]
    pub listing: Account<'info, ServiceListing>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateService<'info> {
    pub owner: Signer<'info>,

    #[account(
        mut,
        has_one = owner @ RegistryError::Unauthorized,
        seeds = [b"listing", listing.owner.as_ref(), listing.capability_hash.as_ref()],
        bump = listing.bump,
    )]
    pub listing: Account<'info, ServiceListing>,
}

#[derive(Accounts)]
pub struct ToggleService<'info> {
    pub owner: Signer<'info>,

    #[account(
        mut,
        has_one = owner @ RegistryError::Unauthorized,
        seeds = [b"listing", listing.owner.as_ref(), listing.capability_hash.as_ref()],
        bump = listing.bump,
    )]
    pub listing: Account<'info, ServiceListing>,
}

#[account]
#[derive(InitSpace)]
pub struct ServiceListing {
    pub owner: Pubkey,
    pub sati_agent_id: u64,
    pub capability_hash: [u8; 32],
    pub price_lamports: u64,
    pub pricing_model: u8,
    pub sla_params: SlaParams,
    #[max_len(MAX_METADATA_URI)]
    pub metadata_uri: String,
    pub is_active: bool,
    pub jobs_completed: u32,
    pub created_at: i64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default, InitSpace)]
pub struct SlaParams {
    pub max_latency_ms: Option<u32>,
    pub min_uptime_pct: Option<u16>,
    #[max_len(MAX_RESPONSE_FORMAT)]
    pub response_format: Option<String>,
    #[max_len(MAX_JSON_SCHEMA_URI)]
    pub json_schema_uri: Option<String>,
    #[max_len(MAX_CUSTOM_PARAMS)]
    pub custom_params: Vec<CustomParam>,
}

impl SlaParams {
    pub fn validate(&self) -> Result<()> {
        if let Some(fmt) = &self.response_format {
            require!(
                fmt.len() <= MAX_RESPONSE_FORMAT,
                RegistryError::SlaFieldTooLong
            );
        }
        if let Some(uri) = &self.json_schema_uri {
            require!(
                uri.len() <= MAX_JSON_SCHEMA_URI,
                RegistryError::SlaFieldTooLong
            );
        }
        if let Some(pct) = self.min_uptime_pct {
            require!(pct <= UPTIME_PCT_MAX_BPS, RegistryError::InvalidUptimePct);
        }
        require!(
            self.custom_params.len() <= MAX_CUSTOM_PARAMS,
            RegistryError::TooManyCustomParams
        );
        for p in &self.custom_params {
            require!(
                p.key.len() <= MAX_CUSTOM_PARAM_KEY,
                RegistryError::SlaFieldTooLong
            );
            require!(
                p.value.len() <= MAX_CUSTOM_PARAM_VAL,
                RegistryError::SlaFieldTooLong
            );
        }
        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default, InitSpace)]
pub struct CustomParam {
    #[max_len(MAX_CUSTOM_PARAM_KEY)]
    pub key: String,
    #[max_len(MAX_CUSTOM_PARAM_VAL)]
    pub value: String,
}

#[event]
pub struct ServiceListingCreated {
    pub listing: Pubkey,
    pub owner: Pubkey,
    pub sati_agent_id: u64,
    pub capability_hash: [u8; 32],
    pub price_lamports: u64,
    pub pricing_model: u8,
    pub metadata_uri: String,
    pub created_at: i64,
}

#[event]
pub struct ServiceListingUpdated {
    pub listing: Pubkey,
    pub owner: Pubkey,
    pub new_price: Option<u64>,
    pub new_uri: Option<String>,
    pub is_active: bool,
    pub updated_at: i64,
}

#[error_code]
pub enum RegistryError {
    #[msg("Only the listing owner can perform this action")]
    Unauthorized,
    #[msg("Capability hash must not be all zero")]
    InvalidCapabilityHash,
    #[msg("Metadata URI exceeds maximum length")]
    MetadataUriTooLong,
    #[msg("Pricing model must be 0..=3 (per_request/per_job/hourly/subscription)")]
    InvalidPricingModel,
    #[msg("min_uptime_pct must be in basis points (0..=10000)")]
    InvalidUptimePct,
    #[msg("SLA param string exceeds maximum length")]
    SlaFieldTooLong,
    #[msg("Too many custom SLA params")]
    TooManyCustomParams,
    #[msg("Listing is already inactive")]
    AlreadyInactive,
    #[msg("Listing is already active")]
    AlreadyActive,
    #[msg("jobs_completed counter would overflow u32")]
    JobsCompletedOverflow,
}
