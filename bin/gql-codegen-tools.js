#!/usr/bin/env node

const [, , command] = process.argv;

async function run() {
  try {
    if (!command) {
      console.error("❌ Missing command. Use: 'factories' or 'handlers'");
      process.exit(1);
    }

    switch (command) {
      case "factories":
        await import("../dist/generateFactories.js");
        break;
      case "handlers":
        await import("../dist/generateHandlers.js");
        break;
      default:
        console.error(
          `❌ Unknown command '${command}'. Use: 'factories' or 'handlers'`,
        );
        process.exit(1);
    }
  } catch (err) {
    console.error("❌ Failed to run CLI:", err);
    process.exit(1);
  }
}

run();
