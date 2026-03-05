# GraphQL Codegen Tools

A CLI tool for generating TypeScript mock factories and MSW handlers from GraphQL fragments and operations. Designed to streamline testing and development workflows in GraphQL-based TypeScript projects.

## Features

- **Factory Generation**: Creates type-safe mock factories from GraphQL fragments
- **Collection Factories**: Generates companion array factories alongside single-entity factories
- **Handler Generation**: Generates MSW (Mock Service Worker) handlers with nested response support
- **Spy Export**: Every handler exports a Storybook-compatible `fn()` spy for test assertions
- **Incremental Updates**: Only regenerates files when source fragments or schema change
- **Manual Customization**: Preserves manual modifications while adding new fields automatically
- **Dependency Resolution**: Automatically handles nested fragment dependencies
- **Storybook Auto-Detection**: Detects `storybook/test` vs `@storybook/test` from your project's dependencies
- **Cache Management**: Tracks generation history to optimize build times

## Installation

```bash
npm install -g gql-codegen-tools
```

Or install locally in your project:

```bash
npm install --save-dev gql-codegen-tools
```

## Usage

### Basic Commands

Generate factory files from GraphQL fragments:
```bash
gql-codegen-tools factories
```

Generate MSW handlers from GraphQL operations:
```bash
gql-codegen-tools handlers
```

### Project Structure Requirements

The tool expects your project to follow this structure:

```
project-root/
├── schema.graphql                  # GraphQL schema file
├── src/
│   └── gql/
│       ├── ids.ts                  # Centralized ID constants
│       └── advertiser/
│           ├── fragments/
│           │   ├── advertiser.fragment.gql
│           │   ├── advertiser.fragment.generated.ts
│           │   ├── advertiser.factory.ts       # Generated
│           │   └── advertisers.factory.ts      # Generated (collection)
│           ├── queries/
│           │   ├── advertisers.query.gql
│           │   ├── advertisers.query.generated.ts
│           │   └── advertisers.handler.ts      # Generated
│           └── mutations/
│               ├── create-advertiser.mutation.gql
│               ├── create-advertiser.mutation.generated.ts
│               └── create-advertiser.handler.ts # Generated
```

Fragment files are discovered at `src/**/*.fragment.gql` and operation files at `src/**/*.{query,mutation}.gql`.

### Integration with npm scripts

Add these scripts to your `package.json`:

```json
{
  "scripts": {
    "codegen:factories": "gql-codegen-tools factories",
    "codegen:handlers": "gql-codegen-tools handlers",
    "codegen": "npm run codegen:factories && npm run codegen:handlers"
  }
}
```

## Factory Generation

### Input: GraphQL Fragment

```graphql
# advertiser.fragment.gql
fragment Advertiser on Advertiser {
  id
  name
  industry
  website
}
```

### Output: Single-Entity Factory

```typescript
// advertiser.factory.ts
import { type AdvertiserFragment } from "./advertiser.fragment.generated";
import { ids } from "../../ids";

const defaultAdvertiser: AdvertiserFragment = {
  id: ids.advertiser[0],
  name: "lorem",
  industry: "Autos & Vehicles",
  website: "www.advertiser.com",
  __typename: "Advertiser",
};

export const createMockAdvertiser = (overwrites: Partial<AdvertiserFragment> = {}): AdvertiserFragment => ({
  ...defaultAdvertiser,
  ...overwrites,
});
```

### Output: Collection Factory

A companion collection factory is generated alongside each single-entity factory:

```typescript
// advertisers.factory.ts
import { type AdvertiserFragment } from "./advertiser.fragment.generated";
import { createMockAdvertiser } from "./advertiser.factory";
import { ids } from "../../ids";

const defaultAdvertisers: AdvertiserFragment[] = [
  createMockAdvertiser(),
  createMockAdvertiser({ id: ids.advertiser[1] }),
];

export const createMockAdvertisers = (overwrites?: AdvertiserFragment[]): AdvertiserFragment[] =>
  overwrites ?? defaultAdvertisers;
```

### Nested Fragments

When a fragment references other fragments, the tool automatically generates factories for dependencies first, then composes them:

```typescript
const defaultAdvertiserWithHierarchy: AdvertiserWithHierarchyFragment = {
  ...createMockAdvertiser(),
  hierarchy: createMockHierarchyWithParent(),
  __typename: "Advertiser",
};
```

### Manual Customization

You can customize generated factories and the tool will preserve your changes. When new fields are added to the fragment, they are automatically inserted while preserving your customizations.

Add a manual marker to prevent any automatic updates:

```typescript
// @manual
const defaultUser: UserFragment = {
  // This factory will never be auto-updated
};
```

## Handler Generation

### Input: GraphQL Operation

```graphql
# advertisers.query.gql
query Advertisers($filter: String) {
  advertisers(name: $filter) {
    ...Advertiser
  }
}
```

### Output: MSW Handler

```typescript
// advertisers.handler.ts
import { HttpResponse } from "msw";
import { fn } from "storybook/test";
import { createMockAdvertiser } from "../fragments/advertiser.factory";
import { mockAdvertisersQuery } from "./advertisers.query.generated";

export const advertisersSpy = fn();

export const advertisers = mockAdvertisersQuery(({ variables }) => {
  advertisersSpy(variables);
  return HttpResponse.json({
    data: {
      advertisers: [createMockAdvertiser()],
    },
  });
});

export default advertisers;
```

### Nested Response Shapes

For queries with nested wrapper types, the handler builds properly nested response objects:

```typescript
export const summary = mockSummaryQuery(({ variables }) => {
  summarySpy(variables);
  return HttpResponse.json({
    data: {
      summary: {
        metrics: [createMockPerformanceMetric()],
        popMetrics: createMockPopMetrics(),
        __typename: "SummaryResponse",
      },
    },
  });
});
```

### Storybook Import Detection

The tool reads your project's `package.json` to determine the correct import path for `fn()`:
- Projects with the `storybook` package (v8+) use `import { fn } from "storybook/test"`
- Older projects use `import { fn } from "@storybook/test"`

## Configuration

### Cache File

The tool creates a `.gql-codegen-cache.json` file to track generation history. Add this to your `.gitignore`:

```gitignore
.gql-codegen-cache.json
```

### ID Management

Create an `src/gql/ids.ts` file for consistent ID generation across factories:

```typescript
export const ids = {
  advertiser: [1, 2, 3],
  hierarchy: [1, 2, 3],
  file: ["1", "2", "3"],
};
```

The tool automatically adds new entries to this file when it encounters `id` fields for new types.

## Dependencies

The generated code expects these peer dependencies in your project:

```json
{
  "devDependencies": {
    "@faker-js/faker": "^9.0.0",
    "msw": "^2.0.0",
    "storybook": "^8.0.0"
  }
}
```

For projects using Storybook 7, use `@storybook/test` instead of `storybook`.

## Troubleshooting

### "No .fragment.gql files found"
Ensure your GraphQL fragments are saved with the `.fragment.gql` extension somewhere under `src/`.

### "Could not find default object"
This usually indicates a malformed factory file. Check that your factory follows the expected structure with a `const defaultObjectName: TypeName = { ... };` pattern.

### Factories not updating
Check if your factory has manual modifications. The tool preserves manual changes by default. To force regeneration, delete the factory file and the `.gql-codegen-cache.json` cache file.

### Files not regenerating after a fresh clone
The cache file is gitignored, so on a fresh clone all auto-generated files will be regenerated on the next run. Files with manual markers (`// @manual`, `// Custom`) are left untouched.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## License

ISC License - see LICENSE file for details.
