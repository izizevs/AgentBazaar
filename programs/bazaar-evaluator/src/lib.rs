use anchor_lang::prelude::*;

declare_id!("BxctnHyx9UJT7XobxHK3X548sSoPQB96Ca2fMEzYYMS8");

#[program]
pub mod bazaar_evaluator {
    use super::*;

    pub fn initialize(_ctx: Context<Initialize>) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}
