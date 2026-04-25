use anchor_lang::prelude::*;

declare_id!("26rhkrBkf75ijDoDuhed8m94FkuhB2MukvqtWYEDegd8");

#[program]
pub mod bazaar_sla {
    use super::*;

    pub fn initialize(_ctx: Context<Initialize>) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}
