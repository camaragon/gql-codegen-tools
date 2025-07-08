#!/usr/bin/env node

// Point to your compiled entry (from TypeScript or raw JS)
import("../dist/generateFactories.js").catch((err) => {
  console.error("❌ Failed to run CLI:", err);
  process.exit(1);
});
