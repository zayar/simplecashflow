/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  typescript: {
    ignoreBuildErrors: true, // We check this in CI/CD pipeline separately
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
