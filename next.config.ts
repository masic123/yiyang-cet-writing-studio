import type { NextConfig } from "next";
const config: NextConfig = {
  poweredByHeader: false,
  output: "export",
  distDir: process.env.CET_EXPORT_DIRECTORY || ".next",
  images: { unoptimized: true },
};
export default config;
