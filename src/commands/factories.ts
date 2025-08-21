import { generateFactory } from "../generators/factory-generator";
import glob from "fast-glob";

export const factoriesCommand = async () => {
  const fragmentPaths = glob.sync("src/**/*/*.fragment.gql");
  if (fragmentPaths.length === 0) {
    console.warn("No .fragment.gql files found. Nothing to generate.");
    return;
  }

  for (const fragmentPath of fragmentPaths) {
    await generateFactory(fragmentPath);
  }
};