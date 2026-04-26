# Devnet Deploy Receipts

## M1.5 upgrade-in-place — 2026-04-26

Changes: emit_cpi! migration (Tasks #34 + #35), USDC mint canonical binding (Task #36),
price_lamports → price_usdc_base_units rename (Task #37).

| Program | Program ID | Slot | Tx Signature |
|---|---|---|---|
| bazaar-registry | `ADWoSmfUWLLRGMWZ61xuAMPhDgG77ziqAC5MA9voqLn3` | 458087865 | `51yqs5GNPf1WaZzVWJjERZTMVNqzNt4ZimXJbTodFC5GBT2sdQb6RUfVDYCVKoNo9iuJrnT6KCqSHWkqxxjHMkL9` |
| bazaar-escrow | `EhFptDs4mz6rt7HDmt8pB7ZogiqxUMVhpjB3NvToXxW2` | 458087904 | `63gbtKQZ8UFXGzcCqyE8ATUVGx5wkYnme6CKwNSKMcx2XGEYpLocgAjQdpTWveWwJpqZz9yPxeqnuzyspURQdnVC` |
| bazaar-sla | `26rhkrBkf75ijDoDuhed8m94FkuhB2MukvqtWYEDegd8` | 458087936 | `3xtEvb4dxUkoujXGn5wDgr7yov6uk6UsGYya3vYxeFBn7hbuM7NwcfDpoajBc3pKg5wPBfqGyLkxrtYwLXioEkeE` |

Deployer: `2hKup37dR2CmScJJ8W9MKyutkyPrSWcwT9MUQfwDH52A`

## M1.5 R2 hotfix — 2026-04-26

Changes: correct devnet USDC mint constant (Task #48, R2). Wrong test-validator mint
`8VEVN5sJUzqN3ddkJV9gYMbLBnmAxUXsC5CDDU9WFwzE` → Circle devnet USDC
`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`. Also simplified cfg-feature pattern
from 3-way (devnet/testing/mainnet) to 2-way (mainnet/not-mainnet).

| Program | Program ID | Slot | Tx Signature |
|---|---|---|---|
| bazaar-escrow | `EhFptDs4mz6rt7HDmt8pB7ZogiqxUMVhpjB3NvToXxW2` | 458162475 | `5z11yrKQ8kGhJaFGtdKLmBZQ1tVB7uyEWhL2TF5AeHBjS3KZC1s7KsgfSQYGvqJNVwAqE2NS1JGMy4ErqCzMFgtu` |

Deployer: `2hKup37dR2CmScJJ8W9MKyutkyPrSWcwT9MUQfwDH52A`
