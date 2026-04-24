use anchor_lang::prelude::*;

declare_id!("GJRgCCqkYvAezidpdd3i4p4kRRfJnM1EfGfgqYgchQqd");

#[program]
pub mod bazaar_registry {
    use super::*;

    pub fn initialize(_ctx: Context<Initialize>) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}
