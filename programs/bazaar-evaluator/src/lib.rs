use anchor_lang::prelude::*;

declare_id!("A1T7iQSYSuogzYme4HncjWoojuJ3WWT2BxEQ2xYp4ZUy");

#[program]
pub mod bazaar_evaluator {
    use super::*;

    pub fn initialize(_ctx: Context<Initialize>) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}
