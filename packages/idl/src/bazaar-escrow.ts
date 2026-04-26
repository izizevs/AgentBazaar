/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/bazaar_escrow.json`.
 */
export type BazaarEscrow = {
  "address": "EhFptDs4mz6rt7HDmt8pB7ZogiqxUMVhpjB3NvToXxW2",
  "metadata": {
    "name": "bazaarEscrow",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "AgentBazaar escrow program — SLA-enforced USDC escrow with state machine.",
    "repository": "https://github.com/izizevs/AgentBazaar"
  },
  "instructions": [
    {
      "name": "claimTimeout",
      "docs": [
        "Seller claims payment after deadline passes with delivery submitted but not confirmed."
      ],
      "discriminator": [
        130,
        234,
        45,
        53,
        120,
        90,
        86,
        178
      ],
      "accounts": [
        {
          "name": "seller",
          "signer": true,
          "relations": [
            "escrow"
          ]
        },
        {
          "name": "escrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "escrow.buyer",
                "account": "escrowAccount"
              },
              {
                "kind": "account",
                "path": "escrow.listing",
                "account": "escrowAccount"
              },
              {
                "kind": "account",
                "path": "escrow.nonce",
                "account": "escrowAccount"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "escrow"
              }
            ]
          }
        },
        {
          "name": "sellerTokenAccount",
          "writable": true
        },
        {
          "name": "usdcMint",
          "address": "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "eventAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  95,
                  95,
                  101,
                  118,
                  101,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "program",
          "address": "EhFptDs4mz6rt7HDmt8pB7ZogiqxUMVhpjB3NvToXxW2"
        }
      ],
      "args": []
    },
    {
      "name": "confirmDelivery",
      "docs": [
        "Buyer confirms delivery. Applies SLA refund logic, releases funds,",
        "increments listing.jobs_completed via CPI to bazaar-registry."
      ],
      "discriminator": [
        11,
        109,
        227,
        53,
        179,
        190,
        88,
        155
      ],
      "accounts": [
        {
          "name": "buyer",
          "signer": true,
          "relations": [
            "escrow"
          ]
        },
        {
          "name": "escrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "escrow.buyer",
                "account": "escrowAccount"
              },
              {
                "kind": "account",
                "path": "escrow.listing",
                "account": "escrowAccount"
              },
              {
                "kind": "account",
                "path": "escrow.nonce",
                "account": "escrowAccount"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "escrow"
              }
            ]
          }
        },
        {
          "name": "sellerTokenAccount",
          "writable": true
        },
        {
          "name": "buyerTokenAccount",
          "writable": true
        },
        {
          "name": "usdcMint",
          "address": "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
        },
        {
          "name": "listing",
          "writable": true
        },
        {
          "name": "registryProgram",
          "address": "ADWoSmfUWLLRGMWZ61xuAMPhDgG77ziqAC5MA9voqLn3"
        },
        {
          "name": "escrowAuthority",
          "docs": [
            "C1 fix: authority PDA for signing the registry CPI.",
            "Derived from [b\"authority\"] in this program; bazaar-registry verifies",
            "it was signed by the bazaar-escrow program via seeds::program constraint."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "eventAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  95,
                  95,
                  101,
                  118,
                  101,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "program",
          "address": "EhFptDs4mz6rt7HDmt8pB7ZogiqxUMVhpjB3NvToXxW2"
        }
      ],
      "args": [
        {
          "name": "score",
          "type": "u8"
        },
        {
          "name": "tags",
          "type": {
            "vec": "string"
          }
        }
      ]
    },
    {
      "name": "createEscrow",
      "docs": [
        "Buyer transfers USDC to vault PDA and records escrow metadata."
      ],
      "discriminator": [
        253,
        215,
        165,
        116,
        36,
        108,
        68,
        80
      ],
      "accounts": [
        {
          "name": "buyer",
          "writable": true,
          "signer": true
        },
        {
          "name": "listing"
        },
        {
          "name": "escrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "buyer"
              },
              {
                "kind": "account",
                "path": "listing"
              },
              {
                "kind": "arg",
                "path": "nonce"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "escrow"
              }
            ]
          }
        },
        {
          "name": "buyerTokenAccount",
          "writable": true
        },
        {
          "name": "usdcMint",
          "address": "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "rent",
          "address": "SysvarRent111111111111111111111111111111111"
        },
        {
          "name": "eventAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  95,
                  95,
                  101,
                  118,
                  101,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "program",
          "address": "EhFptDs4mz6rt7HDmt8pB7ZogiqxUMVhpjB3NvToXxW2"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        },
        {
          "name": "slaMaxLatencyMs",
          "type": {
            "option": "u32"
          }
        },
        {
          "name": "slaResponseFormat",
          "type": {
            "option": "string"
          }
        },
        {
          "name": "deadlineSecs",
          "type": "i64"
        },
        {
          "name": "nonce",
          "type": "u64"
        }
      ]
    },
    {
      "name": "openDispute",
      "docs": [
        "Buyer opens dispute. M1 stub: full refund to buyer immediately.",
        "V1 will add an arbitration path (see docs/decisions/0002-m1-dispute-stub.md)."
      ],
      "discriminator": [
        137,
        25,
        99,
        119,
        23,
        223,
        161,
        42
      ],
      "accounts": [
        {
          "name": "buyer",
          "signer": true,
          "relations": [
            "escrow"
          ]
        },
        {
          "name": "escrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "escrow.buyer",
                "account": "escrowAccount"
              },
              {
                "kind": "account",
                "path": "escrow.listing",
                "account": "escrowAccount"
              },
              {
                "kind": "account",
                "path": "escrow.nonce",
                "account": "escrowAccount"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "escrow"
              }
            ]
          }
        },
        {
          "name": "buyerTokenAccount",
          "writable": true
        },
        {
          "name": "usdcMint",
          "address": "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "eventAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  95,
                  95,
                  101,
                  118,
                  101,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "program",
          "address": "EhFptDs4mz6rt7HDmt8pB7ZogiqxUMVhpjB3NvToXxW2"
        }
      ],
      "args": [
        {
          "name": "reason",
          "type": "string"
        },
        {
          "name": "evidenceUri",
          "type": "string"
        }
      ]
    },
    {
      "name": "submitDelivery",
      "docs": [
        "Seller submits delivery URI + hash. Must be before deadline."
      ],
      "discriminator": [
        217,
        177,
        33,
        54,
        136,
        185,
        123,
        96
      ],
      "accounts": [
        {
          "name": "seller",
          "signer": true,
          "relations": [
            "escrow"
          ]
        },
        {
          "name": "escrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "escrow.buyer",
                "account": "escrowAccount"
              },
              {
                "kind": "account",
                "path": "escrow.listing",
                "account": "escrowAccount"
              },
              {
                "kind": "account",
                "path": "escrow.nonce",
                "account": "escrowAccount"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "escrow"
              }
            ]
          }
        },
        {
          "name": "sellerTokenAccount",
          "writable": true
        },
        {
          "name": "usdcMint",
          "address": "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "eventAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  95,
                  95,
                  101,
                  118,
                  101,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "program",
          "address": "EhFptDs4mz6rt7HDmt8pB7ZogiqxUMVhpjB3NvToXxW2"
        }
      ],
      "args": [
        {
          "name": "resultUri",
          "type": "string"
        },
        {
          "name": "resultHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "escrowAccount",
      "discriminator": [
        36,
        69,
        48,
        18,
        128,
        225,
        125,
        135
      ]
    },
    {
      "name": "serviceListing",
      "discriminator": [
        117,
        173,
        54,
        52,
        146,
        147,
        124,
        211
      ]
    }
  ],
  "events": [
    {
      "name": "deliverySubmitted",
      "discriminator": [
        104,
        47,
        131,
        41,
        20,
        153,
        87,
        75
      ]
    },
    {
      "name": "disputeOpened",
      "discriminator": [
        239,
        222,
        102,
        235,
        193,
        85,
        1,
        214
      ]
    },
    {
      "name": "escrowCreated",
      "discriminator": [
        70,
        127,
        105,
        102,
        92,
        97,
        7,
        173
      ]
    },
    {
      "name": "escrowStateChanged",
      "discriminator": [
        117,
        80,
        243,
        27,
        8,
        62,
        222,
        99
      ]
    },
    {
      "name": "slaReport",
      "discriminator": [
        234,
        110,
        167,
        52,
        145,
        66,
        168,
        69
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "unauthorized",
      "msg": "Only the authorized party can perform this action"
    },
    {
      "code": 6001,
      "name": "zeroAmount",
      "msg": "Escrow amount must be greater than zero"
    },
    {
      "code": 6002,
      "name": "invalidDeadline",
      "msg": "Invalid deadline — must be positive seconds from now"
    },
    {
      "code": 6003,
      "name": "fieldTooLong",
      "msg": "String field exceeds maximum length"
    },
    {
      "code": 6004,
      "name": "invalidStateTransition",
      "msg": "Invalid state transition for current escrow state"
    },
    {
      "code": 6005,
      "name": "deadlinePassed",
      "msg": "Delivery deadline has already passed"
    },
    {
      "code": 6006,
      "name": "deadlineNotYetPassed",
      "msg": "Deadline has not yet passed — cannot claim timeout"
    },
    {
      "code": 6007,
      "name": "listingMismatch",
      "msg": "Listing account does not match escrow record"
    },
    {
      "code": 6008,
      "name": "tooManyTags",
      "msg": "Too many score tags"
    },
    {
      "code": 6009,
      "name": "arithmeticOverflow",
      "msg": "Arithmetic overflow in amount calculation"
    },
    {
      "code": 6010,
      "name": "invalidScore",
      "msg": "Score must be in range 0–100"
    }
  ],
  "types": [
    {
      "name": "customParam",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "key",
            "type": "string"
          },
          {
            "name": "value",
            "type": "string"
          }
        ]
      }
    },
    {
      "name": "deliverySubmitted",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "escrow",
            "type": "pubkey"
          },
          {
            "name": "seller",
            "type": "pubkey"
          },
          {
            "name": "resultUri",
            "type": "string"
          },
          {
            "name": "resultHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "deliveredAt",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "disputeOpened",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "escrow",
            "type": "pubkey"
          },
          {
            "name": "buyer",
            "type": "pubkey"
          },
          {
            "name": "reason",
            "type": "string"
          },
          {
            "name": "evidenceUri",
            "type": "string"
          },
          {
            "name": "openedAt",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "escrowAccount",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "buyer",
            "type": "pubkey"
          },
          {
            "name": "seller",
            "type": "pubkey"
          },
          {
            "name": "listing",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "slaMaxLatencyMs",
            "type": {
              "option": "u32"
            }
          },
          {
            "name": "slaResponseFormat",
            "type": {
              "option": "string"
            }
          },
          {
            "name": "deadlineTs",
            "type": "i64"
          },
          {
            "name": "nonce",
            "type": "u64"
          },
          {
            "name": "state",
            "type": {
              "defined": {
                "name": "escrowState"
              }
            }
          },
          {
            "name": "createdAt",
            "type": "i64"
          },
          {
            "name": "deliveredAt",
            "type": {
              "option": "i64"
            }
          },
          {
            "name": "resultUri",
            "type": {
              "option": "string"
            }
          },
          {
            "name": "resultHash",
            "type": {
              "option": {
                "array": [
                  "u8",
                  32
                ]
              }
            }
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "vaultBump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "escrowCreated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "escrow",
            "type": "pubkey"
          },
          {
            "name": "buyer",
            "type": "pubkey"
          },
          {
            "name": "seller",
            "type": "pubkey"
          },
          {
            "name": "listing",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "deadlineTs",
            "type": "i64"
          },
          {
            "name": "createdAt",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "escrowState",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "created"
          },
          {
            "name": "delivered"
          },
          {
            "name": "confirmed"
          },
          {
            "name": "timeoutClaimed"
          },
          {
            "name": "disputed"
          }
        ]
      }
    },
    {
      "name": "escrowStateChanged",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "escrow",
            "type": "pubkey"
          },
          {
            "name": "buyer",
            "type": "pubkey"
          },
          {
            "name": "seller",
            "type": "pubkey"
          },
          {
            "name": "oldState",
            "type": {
              "defined": {
                "name": "escrowState"
              }
            }
          },
          {
            "name": "newState",
            "type": {
              "defined": {
                "name": "escrowState"
              }
            }
          },
          {
            "name": "timestamp",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "slaReport",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "escrow",
            "type": "pubkey"
          },
          {
            "name": "buyer",
            "type": "pubkey"
          },
          {
            "name": "seller",
            "type": "pubkey"
          },
          {
            "name": "severity",
            "type": {
              "defined": {
                "name": "slaSeverity"
              }
            }
          },
          {
            "name": "sellerBps",
            "type": "u64"
          },
          {
            "name": "refundBps",
            "type": "u64"
          },
          {
            "name": "score",
            "type": "u8"
          },
          {
            "name": "tags",
            "type": {
              "vec": "string"
            }
          },
          {
            "name": "confirmedAt",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "serviceListing",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "satiAgentId",
            "type": "u64"
          },
          {
            "name": "capabilityHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "priceUsdcBaseUnits",
            "type": "u64"
          },
          {
            "name": "pricingModel",
            "type": "u8"
          },
          {
            "name": "slaParams",
            "type": {
              "defined": {
                "name": "slaParams"
              }
            }
          },
          {
            "name": "metadataUri",
            "type": "string"
          },
          {
            "name": "isActive",
            "type": "bool"
          },
          {
            "name": "jobsCompleted",
            "type": "u32"
          },
          {
            "name": "createdAt",
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "slaParams",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "maxLatencyMs",
            "type": {
              "option": "u32"
            }
          },
          {
            "name": "minUptimePct",
            "type": {
              "option": "u16"
            }
          },
          {
            "name": "responseFormat",
            "type": {
              "option": "string"
            }
          },
          {
            "name": "jsonSchemaUri",
            "type": {
              "option": "string"
            }
          },
          {
            "name": "customParams",
            "type": {
              "vec": {
                "defined": {
                  "name": "customParam"
                }
              }
            }
          }
        ]
      }
    },
    {
      "name": "slaSeverity",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "minor"
          },
          {
            "name": "moderate"
          },
          {
            "name": "major"
          }
        ]
      }
    }
  ]
};
