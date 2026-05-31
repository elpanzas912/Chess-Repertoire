import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async redirects() {
    return [
      {
        source: "/openings.html",
        destination: "/openings",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
