# gql-codegen-tools

A collection of utilities and scripts to streamline working with GraphQL code generation and mock data factories. Built for teams using `graphql-codegen`, `ts-morph`, and fragment-based workflows.

## ✨ Features

- 🏗️ Auto-generates mock factory files from `.fragment.gql` files
- 🧬 Supports scalar, enum, list, and nested fragment fields
- 📚 Generates type-safe mock data using `@faker-js/faker`
- 🔄 Recursively generates nested factories as needed
- ⚙️ Designed to integrate with `graphql-codegen`-generated fragments

## 📦 Installation

Clone the repo:

```bash
git clone git@github.com:camaragon/gql-codegen-tools.git
cd gql-codegen-tools
pnpm install
```

Requires Node.js 18+ and pnpm installed.

## 🚀 Usage

To generate a factory for all fragments:

```bash
pnpm generate
```

To generate a factory for a specific fragment:

```ts
import { generateFactory } from "./generate";

await generateFactory("src/gql/example/example.fragment.gql");
```

## 🧩 Folder Structure

```
src/
  └── gql/
      └── [your fragments and generated types]
  └── generate.ts
  └── utils/
      └── [shared helpers for factory generation]
```

## 🛠 Tech Stack

- graphql
- @faker-js/faker
- ts-morph
- fast-glob

---
