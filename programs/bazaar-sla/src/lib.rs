use anchor_lang::prelude::*;

declare_id!("C94CzM5DRJnj73ZM5YA7PpPJKdmJZHWWFM4yM8aBRHU");

#[program]
pub mod bazaar_sla {
    use super::*;

    pub fn initialize(_ctx: Context<Initialize>) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}
