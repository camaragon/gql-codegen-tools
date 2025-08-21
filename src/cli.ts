#!/usr/bin/env node

import { factoriesCommand } from "./commands/factories";
import { handlersCommand } from "./commands/handlers";

const [, , command] = process.argv;

async function run() {
  try {
    if (!command) {
      console.error("❌ Missing command. Use: 'factories' or 'handlers'");
      process.exit(1);
    }

    switch (command) {
      case "factories":
        await factoriesCommand();
        break;
      case "handlers":
        await handlersCommand();
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