import bazaarRegistryIdl from '../idl/bazaar_registry.json' with { type: 'json' };

export type { BazaarRegistry } from './bazaar-registry.js';
export { IDL as BazaarRegistryIDL } from './generated/bazaar-registry.js';
export type { Metadata } from './metadata-schema.js';
export { computeCapabilityHash, MetadataSchema } from './metadata-schema.js';
export { bazaarRegistryIdl };
