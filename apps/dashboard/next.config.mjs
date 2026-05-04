/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'api.dicebear.com',
      },
    ],
  },
  transpilePackages: ['@agent-bazaar/sdk', '@agent-bazaar/idl'],
  webpack: (config) => {
    // Wallet adapter uses browser APIs — exclude from SSR bundles
    config.resolve.fallback = {
      ...config.resolve.fallback,
      fs: false,
      net: false,
      tls: false,
      crypto: false,
    };

    // Allow TypeScript workspace packages to use `.js` ESM extensions that resolve to `.ts`
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
      '.cjs': ['.cts', '.cjs'],
      '.mjs': ['.mts', '.mjs'],
    };

    return config;
  },
};

export default nextConfig;
