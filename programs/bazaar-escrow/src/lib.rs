use anchor_lang::prelude::*;

declare_id!("qTezZXasYhw2mUQiJC4FSpu1FrDWqawAWdAaWzvdzSs");

#[program]
pub mod bazaar_escrow {
    use super::*;

    pub fn initialize(_ctx: Context<Initialize>) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}
