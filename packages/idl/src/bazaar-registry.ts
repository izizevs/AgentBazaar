/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/bazaar_registry.json`.
 */
export type BazaarRegistry = {
  "address": "ADWoSmfUWLLRGMWZ61xuAMPhDgG77ziqAC5MA9voqLn3",
  "metadata": {
    "name": "bazaarRegistry",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "AgentBazaar service registry — ServiceListing PDAs, discovery metadata.",
    "repository": "https://github.com/izizevs/AgentBazaar"
  },
  "instructions": [
    {
      "name": "deactivateService",
      "discriminator": [
        251,
        86,
        29,
        182,
        216,
        170,
        85,
        155
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "listing"
          ]
        },
        {
          "name": "listing",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  105,
                  115,
                  116,
                  105,
                  110,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "listing.owner",
                "account": "serviceListing"
              },
              {
                "kind": "account",
                "path": "listing.capability_hash",
                "account": "serviceListing"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "incrementJobsCompleted",
      "docs": [
        "CPI-only: called by bazaar-escrow on confirm_delivery.",
        "The escrow_authority PDA (seeds=[b\"authority\"], program=bazaar-escrow)",
        "must sign — enforced by the Signer + seeds::program constraint below."
      ],
      "discriminator": [
        58,
        56,
        73,
        152,
        185,
        168,
        135,
        163
      ],
      "accounts": [
        {
          "name": "listing",
          "writable": true
        },
        {
          "name": "escrowAuthority",
          "docs": [
            "C1 fix: PDA derived from [b\"authority\"] in bazaar-escrow program.",
            "Only bazaar-escrow can produce a valid signer here via CPI invoke_signed."
          ],
          "signer": true,
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
            ],
            "program": {
              "kind": "const",
              "value": [
                203,
                119,
                236,
                252,
                205,
                150,
                208,
                237,
                108,
                31,
                90,
                160,
                202,
                133,
                96,
                54,
                36,
                63,
                66,
                249,
                62,
                84,
                105,
                214,
                90,
                130,
                198,
                58,
                1,
                173,
                98,
                223
              ]
            }
          }
        }
      ],
      "args": []
    },
    {
      "name": "reactivateService",
      "discriminator": [
        187,
        36,
        42,
        54,
        189,
        110,
        48,
        186
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "listing"
          ]
        },
        {
          "name": "listing",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  105,
                  115,
                  116,
                  105,
                  110,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "listing.owner",
                "account": "serviceListing"
              },
              {
                "kind": "account",
                "path": "listing.capability_hash",
                "account": "serviceListing"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "registerService",
      "discriminator": [
        11,
        133,
        158,
        232,
        193,
        19,
        229,
        73
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true
        },
        {
          "name": "listing",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  105,
                  115,
                  116,
                  105,
                  110,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "arg",
                "path": "capabilityHash"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
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
          "name": "satiAgentId",
          "type": "u64"
        },
        {
          "name": "priceLamports",
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
        }
      ]
    },
    {
      "name": "updateService",
      "discriminator": [
        46,
        169,
        26,
        33,
        191,
        78,
        40,
        221
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "listing"
          ]
        },
        {
          "name": "listing",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  105,
                  115,
                  116,
                  105,
                  110,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "listing.owner",
                "account": "serviceListing"
              },
              {
                "kind": "account",
                "path": "listing.capability_hash",
                "account": "serviceListing"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "newPrice",
          "type": {
            "option": "u64"
          }
        },
        {
          "name": "newSla",
          "type": {
            "option": {
              "defined": {
                "name": "slaParams"
              }
            }
          }
        },
        {
          "name": "newUri",
          "type": {
            "option": "string"
          }
        }
      ]
    }
  ],
  "accounts": [
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
      "name": "serviceListingCreated",
      "discriminator": [
        214,
        51,
        85,
        39,
        92,
        202,
        181,
        120
      ]
    },
    {
      "name": "serviceListingUpdated",
      "discriminator": [
        234,
        45,
        86,
        218,
        125,
        0,
        37,
        210
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "unauthorized",
      "msg": "Only the listing owner can perform this action"
    },
    {
      "code": 6001,
      "name": "invalidCapabilityHash",
      "msg": "Capability hash must not be all zero"
    },
    {
      "code": 6002,
      "name": "metadataUriTooLong",
      "msg": "Metadata URI exceeds maximum length"
    },
    {
      "code": 6003,
      "name": "invalidPricingModel",
      "msg": "Pricing model must be 0..=3 (per_request/per_job/hourly/subscription)"
    },
    {
      "code": 6004,
      "name": "invalidUptimePct",
      "msg": "min_uptime_pct must be in basis points (0..=10000)"
    },
    {
      "code": 6005,
      "name": "slaFieldTooLong",
      "msg": "SLA param string exceeds maximum length"
    },
    {
      "code": 6006,
      "name": "tooManyCustomParams",
      "msg": "Too many custom SLA params"
    },
    {
      "code": 6007,
      "name": "alreadyInactive",
      "msg": "Listing is already inactive"
    },
    {
      "code": 6008,
      "name": "alreadyActive",
      "msg": "Listing is already active"
    },
    {
      "code": 6009,
      "name": "jobsCompletedOverflow",
      "msg": "jobs_completed counter would overflow u32"
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
            "name": "priceLamports",
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
      "name": "serviceListingCreated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "listing",
            "type": "pubkey"
          },
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
            "name": "priceLamports",
            "type": "u64"
          },
          {
            "name": "pricingModel",
            "type": "u8"
          },
          {
            "name": "metadataUri",
            "type": "string"
          },
          {
            "name": "createdAt",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "serviceListingUpdated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "listing",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "newPrice",
            "type": {
              "option": "u64"
            }
          },
          {
            "name": "newUri",
            "type": {
              "option": "string"
            }
          },
          {
            "name": "isActive",
            "type": "bool"
          },
          {
            "name": "updatedAt",
            "type": "i64"
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
    }
  ]
};
